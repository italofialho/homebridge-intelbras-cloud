import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { DeviceConfig } from "./config";
import { Dvr } from "./dvr";
import { Camera } from "./camera";
const PLUGIN = "homebridge-intelbras-cloud",
  PLATFORM = "IntelbrasCloud";
class Platform implements DynamicPlatformPlugin {
  private devices: Dvr[] = [];
  private cameras: Camera[] = [];
  private closed = false;
  private retries = new Set<NodeJS.Timeout>();
  constructor(
    private log: Logger,
    private config: PlatformConfig,
    private api: API,
  ) {
    api.on("didFinishLaunching", () => void this.launch());
    api.on("shutdown", () => {
      this.closed = true;
      this.retries.forEach(clearTimeout);
      this.cameras.forEach((c) => c.close());
      this.devices.forEach((d) => d.close());
    });
  }
  configureAccessory(_accessory: PlatformAccessory) {}
  private async launch() {
    const configs = (this.config.devices ?? []) as DeviceConfig[];
    const ids = new Set<string>();
    for (const d of configs) {
      if (ids.has(d.id)) {
        this.log.error("Duplicate device id; skipped");
        continue;
      }
      ids.add(d.id);
      await this.launchDevice(d);
    }
  }
  private async launchDevice(d: DeviceConfig) {
    if (this.closed) return;
    let dvr: Dvr | undefined;
    const cameraStart = this.cameras.length;
    try {
      dvr = new Dvr(d);
      this.devices.push(dvr);
      const channels = await dvr.discover();
      if (this.closed) return;
      const selected = d.channels?.length
        ? d.channels
        : channels.map((c) => ({ id: c.id, name: c.name }));
      const accessories: PlatformAccessory[] = [];
      for (const c of selected) {
        const discovered = channels.find((x) => x.id === c.id);
        if (!discovered) {
          this.log.warn(`Channel ${c.id} unavailable`);
          continue;
        }
        const id = this.api.hap.uuid.generate(`${PLUGIN}:${d.id}:${c.id}`);
        const a = new this.api.platformAccessory(
          c.name ?? `${d.name} ${discovered.name}`,
          id,
          this.api.hap.Categories.IP_CAMERA,
        );
        a.getService(this.api.hap.Service.AccessoryInformation)!
          .setCharacteristic(
            this.api.hap.Characteristic.Manufacturer,
            "Intelbras",
          )
          .setCharacteristic(this.api.hap.Characteristic.Model, dvr.model)
          .setCharacteristic(
            this.api.hap.Characteristic.SerialNumber,
            `${d.id}-${c.id}`,
          )
          .setCharacteristic(
            this.api.hap.Characteristic.FirmwareRevision,
            dvr.firmware.slice(0, 64),
          );
        this.cameras.push(
          new Camera(this.api, dvr, c, a, (s) =>
            this.log.warn(`Channel ${c.id}: ${s}`),
          ),
        );
        accessories.push(a);
      }
      this.api.publishExternalAccessories(PLUGIN, accessories);
      dvr.on("diagnostic", (s) => this.log.warn(s));
      dvr.startEvents();
      this.log.info(
        `Published ${accessories.length} cameras for configured device`,
      );
    } catch {
      this.cameras.splice(cameraStart).forEach((c) => c.close());
      if (dvr) this.devices = this.devices.filter((x) => x !== dvr);
      dvr?.close();
      this.log.error(
        "Device initialization failed: check connection, credentials and CONNECT support; retrying in 30 seconds",
      );
      if (!this.closed) {
        const t = setTimeout(() => {
          this.retries.delete(t);
          void this.launchDevice(d);
        }, 30000);
        this.retries.add(t);
      }
    }
  }
}
export = (api: API) => api.registerPlatform(PLUGIN, PLATFORM, Platform);
