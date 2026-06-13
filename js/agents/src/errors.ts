/**
 * IncompatibleProtocolError — thrown when an operation would deterministically
 * fail because every relevant counterpart runs an older agents-protocol
 * (pre-directed-replies). Failing fast beats burning the correlation timeout.
 */
export class IncompatibleProtocolError extends Error {
  constructor(operation: string, agents: Array<{ name: string; protocol: number }>) {
    const list = agents.map((a) => `${a.name} (protocol ${a.protocol})`).join(", ");
    super(
      `${operation} cannot succeed: every relevant agent advertises agents-protocol < 2 ` +
        `[${list}]. Protocol >= 2 responders direct replies to the requester; older ones ` +
        `broadcast and their replies never reach this SDK's filtered subscription. ` +
        `Upgrade the responders to @nolag/agents >= 0.2.0 / nolag-agents >= 0.3.0. ` +
        `NOTE: 0.2.x/0.3.0 responders DO have directed replies but do not yet advertise ` +
        `protocol — if your responders run those versions, pass { allowLegacyResponders: true }.`
    );
    this.name = "IncompatibleProtocolError";
  }
}
