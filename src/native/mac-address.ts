
import { fromBase64 } from './base64';
import { BlePlxDevice } from './ble-plx';

/**
 * Getting hold of a cube's MAC address, which is the hardest part of talking to
 * one from a phone.
 *
 * GAN salts the encryption key and IV with the cube's MAC (see `saltFromMAC`).
 * Without it there is no connection — not a degraded one, none. And the two
 * mobile platforms disagree completely about whether an app may know it:
 *
 *  - **Android** puts the MAC in `device.id`, in the usual colon-separated form.
 *    Nothing else is needed.
 *  - **iOS** does not. CoreBluetooth deliberately replaces it with a per-app,
 *    per-device random UUID, and there is no API that will ever return the real
 *    address. The only route is the advertisement itself: GAN broadcasts the MAC
 *    in its manufacturer-specific data, which `react-native-ble-plx` surfaces as
 *    `device.manufacturerData` **on scan results**.
 *
 * That last sentence is a constraint on the UI, not just on this file. A scan
 * result carries the manufacturer data; a `Device` obtained any other way — from
 * `devices()`, from a stored id, from a reconnect — generally does not. So a
 * connect flow that lists cubes, throws the scan results away and reconnects by
 * id later **cannot work on iOS**. Keep the scan result, or keep the MAC it
 * yielded.
 */

/** Colon-separated uppercase hex, six octets. */
const MAC_PATTERN = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** Format six bytes the way the rest of the library expects to read them. */
function formatMAC(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join(':');
}

/**
 * Pull the MAC out of a GAN advertisement's manufacturer-specific data.
 *
 * The layout matches what the Web Bluetooth path already assumes: two bytes of
 * company identifier, then a nine-byte payload whose **last six bytes are the
 * MAC in reverse order**. Returns null rather than throwing, because a
 * non-GAN device in the scan results is ordinary, not exceptional.
 */
function macFromManufacturerData(manufacturerDataBase64: string | null | undefined): string | null {
    if (!manufacturerDataBase64) return null;
    var raw = fromBase64(manufacturerDataBase64);
    // Two bytes of CIC, then the payload — the same window the Bluefy branch of
    // `getManufacturerDataBytes` takes.
    var payload = raw.subarray(2, 11);
    if (payload.length < 6) return null;
    var reversed = payload.subarray(payload.length - 6);
    var mac = new Uint8Array(6);
    for (let i = 0; i < 6; i++) {
        mac[i] = reversed[5 - i];
    }
    return formatMAC(mac);
}

/**
 * A provider the app can supply when neither route works — typically a text
 * field asking the person to read the MAC off the cube's packaging or a
 * companion app. Mirrors `MacAddressProvider` on the web side.
 */
type NativeMacAddressProvider = (device: BlePlxDevice) => Promise<string | null>;

/**
 * Work out a cube's MAC address from a scan result.
 *
 * Tries, in order: the device id when it is already a MAC (Android), the
 * advertisement's manufacturer data (iOS, and Android as a cross-check), and
 * finally whatever the app offers. Throws only when all three have failed,
 * because at that point there is genuinely nothing to connect with.
 */
async function resolveCubeMAC(device: BlePlxDevice, provider?: NativeMacAddressProvider): Promise<string> {
    if (MAC_PATTERN.test(device.id))
        return device.id.replace(/-/g, ':').toUpperCase();
    var advertised = macFromManufacturerData(device.manufacturerData);
    if (advertised)
        return advertised;
    var supplied = provider && await provider(device);
    if (supplied && MAC_PATTERN.test(supplied))
        return supplied.replace(/-/g, ':').toUpperCase();
    throw new Error(
        'Unable to determine cube MAC address. On iOS the address is only available ' +
        'from the advertisement of a scan result — reconnecting by device id will not ' +
        'supply it. Keep the scan result, or provide the address explicitly.'
    );
}

export type {
    NativeMacAddressProvider
};

export {
    MAC_PATTERN,
    formatMAC,
    macFromManufacturerData,
    resolveCubeMAC
};
