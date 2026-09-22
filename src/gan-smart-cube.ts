
import * as def from './gan-cube-definitions';
import { createGanCubeConnection } from './gan-cube-connection';
import { createDriver, createEncrypter, generationForService, GAN_SERVICES } from './gan-cube-generations';
import { WebBluetoothTransport } from './transports/web-bluetooth';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove
} from './gan-cube-protocol';

/** Iterate over all known GAN cube CICs to find Manufacturer Specific Data */
function getManufacturerDataBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
    // Workaround for Bluefy browser which may return raw DataView directly instead of Map
    if (manufacturerData instanceof DataView) {
        return new DataView(manufacturerData.buffer.slice(2, 11));
    }
    for (var id of def.GAN_CIC_LIST) {
        if (manufacturerData.has(id)) {
            return new DataView(manufacturerData.get(id)!.buffer.slice(0, 9));
        }
    }
    return;
}

/** Extract MAC from last 6 bytes of Manufacturer Specific Data */
function extractMAC(manufacturerData: BluetoothManufacturerData): string {
    var mac: Array<string> = [];
    var dataView = getManufacturerDataBytes(manufacturerData);
    if (dataView && dataView.byteLength >= 6) {
        for (let i = 1; i <= 6; i++) {
            mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, "0"));
        }
    }
    return mac.join(":");
}

/** If browser supports Web Bluetooth watchAdvertisements() API, try to retrieve MAC address automatically */
async function autoRetrieveMacAddress(device: BluetoothDevice): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
        if (typeof device.watchAdvertisements != 'function') {
            resolve(null);
        }
        var abortController = new AbortController();
        var onAdvEvent = (evt: Event) => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            var mac = extractMAC((evt as BluetoothAdvertisingEvent).manufacturerData);
            resolve(mac || null);
        };
        var onAbort = () => {
            device.removeEventListener("advertisementreceived", onAdvEvent);
            abortController.abort();
            resolve(null);
        };
        device.addEventListener("advertisementreceived", onAdvEvent);
        device.watchAdvertisements({ signal: abortController.signal }).catch(onAbort);
        setTimeout(onAbort, 10000);
    });
}

/**
 * Type representing function interface to implement custom MAC address provider
 * @param device Current BluetoothDevice selected by user.
 * @param isFallbackCall Flag indicating this is final and last resort call for MAC address.
 *                       If this flag is not set, custom provider can return null instead of MAC,
 *                       in such case library will try to read MAC automatically.
 */
type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

/**
 * Initiate new connection with the GAN Smart Cube device
 *
 * The signature and behaviour are unchanged; internally the Web Bluetooth
 * plumbing now lives in `WebBluetoothTransport` and the protocol pipeline in
 * `createGanCubeConnection`, so the same cube can be driven from React Native or
 * from a recording without any of this file being involved.
 *
 * @param customMacAddressProvider Optional custom provider for cube MAC address
 * @returns Object representing connection API and state
 */
async function connectGanCube(customMacAddressProvider?: MacAddressProvider): Promise<GanCubeConnection> {

    // Request user for the bluetooth device (popup selection dialog)
    var device: BluetoothDeviceWithMAC = await navigator.bluetooth.requestDevice(
        {
            filters: [
                { namePrefix: "GAN" },
                { namePrefix: "MG" },
                { namePrefix: "AiCube" }
            ],
            optionalServices: GAN_SERVICES,
            optionalManufacturerData: def.GAN_CIC_LIST
        }
    );

    // Retrieve cube MAC address needed for key salting
    var mac = customMacAddressProvider && await customMacAddressProvider(device, false)
        || await autoRetrieveMacAddress(device)
        || customMacAddressProvider && await customMacAddressProvider(device, true);

    if (!mac)
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    device.mac = mac;

    // Connect to GATT and get device primary services
    var gatt = await device.gatt!.connect();
    var services = await gatt.getPrimaryServices();

    // Resolve type of connected cube device and setup appropriate encryption / protocol driver
    for (let service of services) {
        let profile = generationForService(service.uuid);
        if (!profile) continue;
        let commandCharacteristic = await service.getCharacteristic(profile.commandCharacteristic);
        let stateCharacteristic = await service.getCharacteristic(profile.stateCharacteristic);
        let transport = await WebBluetoothTransport.create(device, mac, commandCharacteristic, stateCharacteristic);
        return createGanCubeConnection(
            transport,
            createEncrypter(profile.generation, mac, device.name ?? undefined),
            createDriver(profile.generation)
        );
    }

    throw new Error("Can't find target BLE services - wrong or unsupported cube device model");

}

export type {
    MacAddressProvider,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove
};

export {
    connectGanCube,
    extractMAC,
    getManufacturerDataBytes
};
