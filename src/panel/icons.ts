// The side panel's icons come from StyleLift's one icon set (src/shared/icons.ts), so an action looks the
// same in the panel and in Studio. Older names used around the panel map onto it here.
import { icon as base } from "../shared/icons";

const ALIAS: Record<string, string> = { up: "chevronUp", down: "chevronDown" };
export function icon(name: string, size = 15): string {
  return base(ALIAS[name] || name, size);
}
