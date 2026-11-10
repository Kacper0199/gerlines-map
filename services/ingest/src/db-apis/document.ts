import { errorMessage } from "../log.ts";
import { scanXml } from "./xml.ts";

/**
 * Why a recorded document is not what its source declares, or null when it is: JSON must parse, XML must be
 * well formed and, when `root` is given, have that root element (an IRIS answer is `<timetable>`). The XML
 * check builds no tree, so a large answer costs about its own size in memory.
 */
export function documentProblem(contentType: string, body: Buffer, root?: string): string | null {
  const text = body.toString("utf8");
  if (contentType.includes("json")) {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return `payload is not JSON: ${errorMessage(error)}`;
    }
  }
  if (!contentType.includes("xml")) return null;
  let name: string;
  try {
    name = scanXml(text).root;
  } catch (error) {
    return `payload is not well-formed XML: ${errorMessage(error)}`;
  }
  return root && name !== root ? `XML root is <${name}>, expected <${root}>` : null;
}
