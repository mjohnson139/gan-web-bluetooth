
/**
 * Driving the library with no cube attached.
 *
 * Published as `gan-web-bluetooth/simulation` rather than from the root, so
 * that an app shipping to a phone does not pull frame builders it will never
 * call into its bundle.
 */

export type { FrameMove } from './frames';
export {
    BitWriter,
    GEN2_FRAME_BYTES,
    SOLVED_FACELETS,
    gen2SolvedFaceletsFrame,
    gen2MoveFrame,
    gen2GyroFrame,
    gen2BatteryFrame,
    gen2HardwareFrame
} from './frames';

export type { SimulatedGanCube, SimulatedGanCubeOptions } from './simulated-cube';
export { createSimulatedGanCube } from './simulated-cube';
