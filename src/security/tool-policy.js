/**
 * ToolPolicy — Single-user model.
 * All tools are available. The approval workflow (Spec 19) is the safety gate.
 */
export class ToolPolicy {
  isAllowed(_toolName, _userId, _session) {
    return true;
  }

  getEffectiveToolNames(_userId, _session) {
    return null;
  }
}
