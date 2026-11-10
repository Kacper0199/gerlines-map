export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

export class XmlError extends Error {}

interface MutableElement {
  name: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
}

const NAME = /^[A-Za-z_][\w.:-]*/;
const ATTRIBUTE = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function codePointOf(body: string): number {
  if (/^#x[0-9a-f]+$/i.test(body)) return Number.parseInt(body.slice(2), 16);
  if (/^#\d+$/.test(body)) return Number.parseInt(body.slice(1), 10);
  return Number.NaN;
}

export function decodeEntities(value: string): string {
  return value.replace(/&([^;\s&]{1,10});|&/g, (match, body: string | undefined) => {
    if (body === undefined) throw new XmlError("bare & in XML text");
    if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body] as string;
    const code = codePointOf(body);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) {
      throw new XmlError(`unknown entity ${match}`);
    }
    return String.fromCodePoint(code);
  });
}

function indexAfter(input: string, from: number, terminator: string, what: string): number {
  const end = input.indexOf(terminator, from);
  if (end === -1) throw new XmlError(`unterminated ${what}`);
  return end;
}

/** The most elements `parseXml` builds a tree for; a 2 MiB IRIS document of empty elements stays below it. */
export const XML_MAX_ELEMENTS = 200_000;

interface ReaderOptions {
  readonly build: boolean;
  readonly maxElements: number;
}

class Reader {
  private readonly input: string;
  private readonly options: ReaderOptions;
  private readonly stack: MutableElement[] = [];
  private root: MutableElement | null = null;
  elements = 0;

  constructor(input: string, options: ReaderOptions) {
    this.input = input;
    this.options = options;
  }

  read(): XmlElement {
    const { input } = this;
    let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < input.length) {
      const lt = input.indexOf("<", i);
      const textEnd = lt === -1 ? input.length : lt;
      if (textEnd > i) this.appendText(decodeEntities(input.slice(i, textEnd)));
      if (lt === -1) break;
      i = this.readMarkup(lt);
    }
    if (this.stack.length > 0) {
      throw new XmlError(`element <${this.stack.at(-1)?.name}> is not closed`);
    }
    if (this.root === null) throw new XmlError("no root element");
    return this.root;
  }

  private appendText(text: string): void {
    const top = this.stack.at(-1);
    if (!top) {
      if (text.trim() !== "") throw new XmlError("text outside the root element");
    } else if (this.options.build) {
      top.text += text;
    }
  }

  private readMarkup(lt: number): number {
    const { input } = this;
    if (input.startsWith("<?", lt)) {
      return indexAfter(input, lt + 2, "?>", "processing instruction") + 2;
    }
    if (input.startsWith("<!--", lt)) return indexAfter(input, lt + 4, "-->", "comment") + 3;
    if (input.startsWith("<![CDATA[", lt)) {
      const end = indexAfter(input, lt + 9, "]]>", "CDATA section");
      this.appendText(input.slice(lt + 9, end));
      return end + 3;
    }
    if (input.startsWith("<!", lt)) {
      throw new XmlError("document type declarations are not accepted");
    }
    if (input.startsWith("</", lt)) return this.readEndTag(lt);
    return this.readStartTag(lt + 1);
  }

  private readEndTag(lt: number): number {
    const end = indexAfter(this.input, lt, ">", "end tag");
    const name = this.input.slice(lt + 2, end).trim();
    const open = this.stack.pop();
    if (!open || open.name !== name) {
      throw new XmlError(`end tag </${name}> does not match <${open?.name ?? "nothing"}>`);
    }
    return end + 1;
  }

  private readStartTag(start: number): number {
    const nameMatch = NAME.exec(this.input.slice(start, start + 256));
    if (!nameMatch) throw new XmlError(`invalid tag at offset ${start}`);
    this.elements += 1;
    if (this.options.build && this.elements > this.options.maxElements) {
      throw new XmlError(`more than ${this.options.maxElements} elements`);
    }
    const element: MutableElement = { name: nameMatch[0], attributes: {}, children: [], text: "" };
    const i = this.readAttributes(element, start + nameMatch[0].length);
    const parent = this.stack.at(-1);
    if (parent) {
      if (this.options.build) parent.children.push(element);
    } else if (this.root === null) this.root = element;
    else throw new XmlError("more than one root element");
    if (this.input.startsWith("/>", i)) return i + 2;
    this.stack.push(element);
    return i + 1;
  }

  private readAttributes(element: MutableElement, from: number): number {
    const { input } = this;
    let i = from;
    for (;;) {
      while (i < input.length && /\s/.test(input.charAt(i))) i += 1;
      if (i >= input.length) throw new XmlError(`unterminated tag <${element.name}>`);
      if (input.startsWith("/>", i) || input.startsWith(">", i)) return i;
      const attribute = ATTRIBUTE.exec(input.slice(i, i + 65_536));
      const key = attribute?.[1];
      if (!attribute || !key) throw new XmlError(`invalid attribute in <${element.name}>`);
      this.setAttribute(element, key, attribute[3] ?? attribute[4] ?? "");
      i += attribute[0].length;
    }
  }

  private setAttribute(element: MutableElement, key: string, raw: string): void {
    if (Object.hasOwn(element.attributes, key)) {
      throw new XmlError(`duplicate attribute ${key} in <${element.name}>`);
    }
    const value = decodeEntities(raw);
    element.attributes[key] = this.options.build ? value : "";
  }
}

/**
 * A strict reader for the plain XML that DB Timetables returns: elements, attributes, text, comments and
 * CDATA. Document type declarations are refused, so no entity expansion or external fetch can happen.
 */
export function parseXml(
  input: string,
  options: { readonly maxElements?: number } = {},
): XmlElement {
  return new Reader(input, {
    build: true,
    maxElements: options.maxElements ?? XML_MAX_ELEMENTS,
  }).read();
}

/**
 * Checks a document with the same strict rules as `parseXml` without building its tree: the memory it
 * needs grows with the nesting depth, not with the document. Returns the root element's name.
 */
export function scanXml(input: string): { readonly root: string; readonly elements: number } {
  const reader = new Reader(input, { build: false, maxElements: Number.POSITIVE_INFINITY });
  const root = reader.read().name;
  return { root, elements: reader.elements };
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}
