import { LRParser } from "@lezer/lr"
import { TOKEN } from 'codemirror-lang-orgmode'

export interface OrgPosition {
  start: { line: number; col: number; offset: number }
  end: { line: number; col: number; offset: number }
}

export interface OrgHeadingCache {
  heading: string
  level: number
  position: OrgPosition
}

export interface OrgLinkCache {
  link: string
  original: string
  displayText?: string
  position: OrgPosition
}

export interface OrgTagCache {
  tag: string
  position: OrgPosition
}

export interface OrgSectionCache {
  type: string
  position: OrgPosition
}

export interface OrgFrontmatter {
  [key: string]: any
}

export interface OrgCachedMetadata {
  headings?: OrgHeadingCache[]
  links?: OrgLinkCache[]
  tags?: OrgTagCache[]
  sections?: OrgSectionCache[]
  frontmatter?: OrgFrontmatter
  frontmatterPosition?: OrgPosition
}

function buildOffsetToLineCol(content: string): (offset: number) => { line: number; col: number } {
  const lineStarts: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
  return (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1
    }
    return { line: lo, col: offset - lineStarts[lo] }
  }
}

function extractRegularLinkTarget(raw: string): { link: string; displayText: string } {
  const inner = raw.slice(2, -2)
  const pipeIdx = inner.indexOf('][')
  if (pipeIdx >= 0) {
    return { link: inner.slice(0, pipeIdx), displayText: inner.slice(pipeIdx + 2) }
  }
  return { link: inner, displayText: inner }
}

function normalizeLinkForObsidian(raw: string): string {
  if (raw.startsWith("id:")) return raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  if (raw.startsWith("file://")) return raw
  const hashIdx = raw.indexOf('#')
  const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  const suffix = hashIdx >= 0 ? raw.slice(hashIdx) : ''
  const lastSlash = base.lastIndexOf('/')
  const lastName = lastSlash >= 0 ? base.slice(lastSlash + 1) : base
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(lastName)
  const withExt = hasExt ? base : base + ".org"
  return withExt + suffix
}

const INLINE_LINK_PATTERN = /\[\[([^\]]+?)(?:\]\[([^\]]+?))?\]\]/g

function scanInlineLinks(
  content: string,
  baseOffset: number,
  text: string,
  posOf: (offset: number) => { line: number; col: number },
  links: OrgLinkCache[],
) {
  INLINE_LINK_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_LINK_PATTERN.exec(text)) !== null) {
    const from = baseOffset + m.index
    const to = from + m[0].length
    const target = m[1]
    const display = m[2] ?? target
    const start = posOf(from), end = posOf(to)
    links.push({
      link: normalizeLinkForObsidian(target),
      original: m[0],
      displayText: display,
      position: {
        start: { line: start.line, col: start.col, offset: from },
        end: { line: end.line, col: end.col, offset: to },
      },
    })
  }
}

function parseTagValue(raw: string): string[] {
  const trimmed = raw.trim()
  const colonForm = trimmed.match(/^:([^:]+(?::[^:]+)*):$/)
  if (colonForm) return colonForm[1].split(':').filter(Boolean)
  return trimmed.split(/\s+/).filter(Boolean)
}

export function extractOrgMetadata(parser: LRParser, content: string): OrgCachedMetadata {
  const tree = parser.parse(content)
  const posOf = buildOffsetToLineCol(content)

  const headings: OrgHeadingCache[] = []
  const links: OrgLinkCache[] = []
  const tags: OrgTagCache[] = []
  const sections: OrgSectionCache[] = []
  const frontmatter: OrgFrontmatter = {}
  let frontmatterStart = -1
  let frontmatterEnd = -1

  const makePos = (from: number, to: number): OrgPosition => {
    const s = posOf(from), e = posOf(to)
    return {
      start: { line: s.line, col: s.col, offset: from },
      end: { line: e.line, col: e.col, offset: to },
    }
  }

  tree.iterate({
    enter(node) {
      const id = node.type.id
      if (id === TOKEN.Heading) {
        let level = 0
        let title = ""
        let titleFrom = node.from
        let titleTo = node.from
        const headingTagsRanges: Array<[number, number]> = []
        const cursor = node.node.cursor()
        if (cursor.firstChild()) {
          do {
            const cid = cursor.type.id
            if (cid === 79 /* stars */ || cursor.name === "stars") {
              level = cursor.to - cursor.from
            } else if (cid === TOKEN.Title) {
              title = content.slice(cursor.from, cursor.to).trim()
              titleFrom = cursor.from
              titleTo = cursor.to
            } else if (cid === TOKEN.Tags) {
              headingTagsRanges.push([cursor.from, cursor.to])
            }
          } while (cursor.nextSibling())
        }
        if (level === 0) {
          const lineStart = content.lastIndexOf('\n', node.from - 1) + 1
          const starsMatch = content.slice(lineStart).match(/^(\*+)\s/)
          if (starsMatch) level = starsMatch[1].length
        }
        if (!title) {
          const lineEnd = content.indexOf('\n', node.from)
          const line = content.slice(node.from, lineEnd < 0 ? content.length : lineEnd)
          title = line.replace(/^\*+\s+/, '').replace(/\s+:[\w@%:#]+:\s*$/, '').trim()
        }
        headings.push({
          heading: title,
          level,
          position: makePos(node.from, node.to),
        })
        for (const [tfrom, tto] of headingTagsRanges) {
          const raw = content.slice(tfrom, tto).trim()
          const parts = raw.split(':').filter(t => t.length > 0)
          for (const p of parts) {
            tags.push({
              tag: "#" + p,
              position: makePos(tfrom, tto),
            })
          }
        }
        const titleText = content.slice(titleFrom, titleTo)
        scanInlineLinks(content, titleFrom, titleText, posOf, links)
      } else if (id === TOKEN.RegularLink) {
        const raw = content.slice(node.from, node.to)
        const { link, displayText } = extractRegularLinkTarget(raw)
        links.push({
          link: normalizeLinkForObsidian(link),
          original: raw,
          displayText,
          position: makePos(node.from, node.to),
        })
      } else if (id === TOKEN.AngleLink) {
        const raw = content.slice(node.from, node.to)
        const link = raw.slice(1, -1)
        links.push({
          link: normalizeLinkForObsidian(link),
          original: raw,
          displayText: link,
          position: makePos(node.from, node.to),
        })
      } else if (id === TOKEN.ListItem) {
        const text = content.slice(node.from, node.to)
        scanInlineLinks(content, node.from, text, posOf, links)
        sections.push({ type: "list", position: makePos(node.from, node.to) })
      } else if (id === TOKEN.Section) {
        sections.push({ type: "section", position: makePos(node.from, node.to) })
      } else if (id === TOKEN.Block) {
        sections.push({ type: "code", position: makePos(node.from, node.to) })
      } else if (id === TOKEN.KeywordComment) {
        const raw = content.slice(node.from, node.to)
        const m = raw.match(/^#\+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/m)
        if (m) {
          const key = m[1].toLowerCase()
          const value = m[2]
          if (key === "tags" || key === "filetags") {
            const existing = Array.isArray(frontmatter.tags) ? frontmatter.tags : []
            frontmatter.tags = [...existing, ...parseTagValue(value)]
          } else if (key === "aliases" || key === "alias") {
            const existing = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : []
            const parts = value.trim().split(/\s+/).filter(Boolean)
            frontmatter.aliases = [...existing, ...parts]
          } else if (key in frontmatter) {
            const prev = frontmatter[key]
            frontmatter[key] = Array.isArray(prev) ? [...prev, value] : [prev, value]
          } else {
            frontmatter[key] = value
          }
          if (frontmatterStart === -1) frontmatterStart = node.from
          frontmatterEnd = node.to
        }
      }
    }
  })

  // Scan for a file-level :PROPERTIES: ... :END: block before the first heading.
  // Org's grammar only emits PropertyDrawer tokens under headings, so extract manually.
  const firstHeadingOffset = headings.length ? headings[0].position.start.offset : content.length
  const headText = content.slice(0, firstHeadingOffset)
  const drawerMatch = headText.match(/^[ \t]*:PROPERTIES:[ \t]*\n([\s\S]*?)\n[ \t]*:END:[ \t]*$/m)
  if (drawerMatch) {
    const drawerBody = drawerMatch[1]
    const drawerStart = headText.indexOf(drawerMatch[0])
    const drawerEnd = drawerStart + drawerMatch[0].length
    const propRe = /^[ \t]*:([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/gm
    let pm: RegExpExecArray | null
    while ((pm = propRe.exec(drawerBody)) !== null) {
      const key = pm[1].toLowerCase()
      const val = pm[2]
      if (!(key in frontmatter)) frontmatter[key] = val
    }
    if (frontmatterStart === -1) frontmatterStart = drawerStart
    else frontmatterStart = Math.min(frontmatterStart, drawerStart)
    frontmatterEnd = Math.max(frontmatterEnd, drawerEnd)
  }

  const result: OrgCachedMetadata = {}
  if (headings.length) result.headings = headings
  if (links.length) result.links = links
  if (tags.length) result.tags = tags
  if (sections.length) result.sections = sections
  if (Object.keys(frontmatter).length > 0) {
    result.frontmatter = frontmatter
    if (frontmatterStart >= 0) {
      result.frontmatterPosition = makePos(frontmatterStart, frontmatterEnd)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Write-back: serialize an Obsidian-style frontmatter object back into an org
// file, preserving existing `#+KEYWORD:` lines and `:PROPERTIES:` drawers
// in-place. Returns the new file content.
// ---------------------------------------------------------------------------

interface ExistingKeyLayout {
  kind: "keyword" | "drawer"
  rawKey: string
  indent: string
  // Byte ranges (start inclusive, end exclusive) for each line that contains
  // this key. Multiple entries for a repeated #+KEYWORD: key (list values).
  lineRanges: Array<{ start: number; end: number }>
}

interface FrontmatterLayout {
  keys: Map<string, ExistingKeyLayout>   // lowercase key -> layout
  firstHeadingOffset: number
  // Offset at which new top-level #+KEYWORD: lines should be inserted. This is
  // the offset just after the last existing top-level #+KEYWORD: line, or — if
  // none exist — the start of the file.
  keywordInsertOffset: number
  drawerBodyStart: number   // -1 if no file-level drawer
  drawerBodyEnd: number     // offset of the `:END:` line start
}

function findLineEnd(content: string, offset: number): number {
  const nl = content.indexOf("\n", offset)
  return nl < 0 ? content.length : nl
}

function extractOrgFrontmatterLayout(content: string, headingOffsets: number[]): FrontmatterLayout {
  const firstHeadingOffset = headingOffsets.length ? headingOffsets[0] : content.length
  const keys = new Map<string, ExistingKeyLayout>()
  let keywordInsertOffset = 0
  let drawerBodyStart = -1
  let drawerBodyEnd = -1

  const headText = content.slice(0, firstHeadingOffset)

  // Walk lines before the first heading and collect `#+KEYWORD:` lines.
  let pos = 0
  let lastKeywordLineEnd = -1
  while (pos < headText.length) {
    const lineEnd = findLineEnd(headText, pos)
    const line = headText.slice(pos, lineEnd)
    const m = line.match(/^(\s*)#\+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/)
    if (m) {
      const indent = m[1]
      const rawKey = m[2]
      const lower = rawKey.toLowerCase()
      const range = { start: pos, end: lineEnd }
      const existing = keys.get(lower)
      if (existing) existing.lineRanges.push(range)
      else keys.set(lower, { kind: "keyword", rawKey, indent, lineRanges: [range] })
      lastKeywordLineEnd = lineEnd
    }
    pos = lineEnd + 1
  }
  keywordInsertOffset = lastKeywordLineEnd >= 0 ? lastKeywordLineEnd : 0

  // Scan for a file-level :PROPERTIES: ... :END: drawer.
  const drawerMatch = headText.match(/^([ \t]*):PROPERTIES:[ \t]*\n([\s\S]*?)\n([ \t]*):END:[ \t]*$/m)
  if (drawerMatch) {
    const drawerStart = headText.indexOf(drawerMatch[0])
    const drawerBody = drawerMatch[2]
    const bodyStartOffset = drawerStart + drawerMatch[1].length + ":PROPERTIES:".length
    // bodyStartOffset points at the newline just after :PROPERTIES:; advance past it.
    const bodyStart = bodyStartOffset + 1   // skip '\n'
    const bodyEnd = bodyStart + drawerBody.length
    drawerBodyStart = bodyStart
    drawerBodyEnd = bodyEnd + 1   // include trailing newline; `:END:` line begins here

    const propRe = /^([ \t]*):([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/gm
    let dm: RegExpExecArray | null
    while ((dm = propRe.exec(drawerBody)) !== null) {
      const indent = dm[1]
      const rawKey = dm[2]
      const lower = rawKey.toLowerCase()
      const absStart = bodyStart + dm.index
      const absEnd = absStart + dm[0].length
      if (!keys.has(lower)) {
        keys.set(lower, { kind: "drawer", rawKey, indent, lineRanges: [{ start: absStart, end: absEnd }] })
      }
    }
  }

  return { keys, firstHeadingOffset, keywordInsertOffset, drawerBodyStart, drawerBodyEnd }
}

function formatTagValue(value: any): string {
  const list = Array.isArray(value)
    ? value.map(v => String(v).trim()).filter(Boolean)
    : String(value).trim().split(/\s+/).filter(Boolean)
  if (!list.length) return ""
  return ":" + list.join(":") + ":"
}

function formatScalarValue(value: any): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value)
}

function renderKeywordLines(rawKey: string, indent: string, value: any, lowerKey: string): string[] {
  if (lowerKey === "tags" || lowerKey === "filetags") {
    const v = formatTagValue(value)
    return v ? [`${indent}#+${rawKey}: ${v}`] : []
  }
  if (lowerKey === "aliases" || lowerKey === "alias") {
    const list = Array.isArray(value)
      ? value.map(v => String(v).trim()).filter(Boolean)
      : String(value).trim().split(/\s+/).filter(Boolean)
    return list.length ? [`${indent}#+${rawKey}: ${list.join(" ")}`] : []
  }
  if (Array.isArray(value)) {
    return value.map(v => `${indent}#+${rawKey}: ${formatScalarValue(v)}`)
  }
  return [`${indent}#+${rawKey}: ${formatScalarValue(value)}`]
}

function renderDrawerLine(rawKey: string, indent: string, value: any): string {
  const v = Array.isArray(value) ? value.map(formatScalarValue).join(" ") : formatScalarValue(value)
  return `${indent}:${rawKey}: ${v}`
}

export function writeOrgFrontmatter(
  parser: LRParser,
  content: string,
  newFrontmatter: OrgFrontmatter,
): string {
  // We need heading offsets to find the head region. Use the parser output
  // rather than a regex because the org grammar has heading-recognition rules
  // that a naïve regex would miss.
  const tree = parser.parse(content)
  const headingOffsets: number[] = []
  tree.iterate({
    enter(node) {
      if (node.type.id === TOKEN.Heading) {
        headingOffsets.push(node.from)
        return false
      }
    }
  })

  const layout = extractOrgFrontmatterLayout(content, headingOffsets)

  const targetKeys = new Set(Object.keys(newFrontmatter).map(k => k.toLowerCase()))
  type Edit = { start: number; end: number; replacement: string }
  const edits: Edit[] = []

  // 1) Update or delete existing keys.
  for (const [lower, layout_entry] of layout.keys.entries()) {
    if (!targetKeys.has(lower)) {
      // Deletion. Remove the entire line(s) including trailing newline.
      for (const range of layout_entry.lineRanges) {
        const endWithNl = range.end < content.length && content.charCodeAt(range.end) === 10 ? range.end + 1 : range.end
        edits.push({ start: range.start, end: endWithNl, replacement: "" })
      }
      continue
    }
    const value = newFrontmatter[lower] ?? findCaseInsensitive(newFrontmatter, lower)
    if (layout_entry.kind === "keyword") {
      const rendered = renderKeywordLines(layout_entry.rawKey, layout_entry.indent, value, lower)
      // Replace first line with all rendered lines joined; delete the rest.
      const firstRange = layout_entry.lineRanges[0]
      edits.push({ start: firstRange.start, end: firstRange.end, replacement: rendered.join("\n") })
      for (let i = 1; i < layout_entry.lineRanges.length; i++) {
        const r = layout_entry.lineRanges[i]
        const endWithNl = r.end < content.length && content.charCodeAt(r.end) === 10 ? r.end + 1 : r.end
        edits.push({ start: r.start, end: endWithNl, replacement: "" })
      }
      if (rendered.length > 1) {
        // Insert additional newlines so each extra rendered line becomes its own line.
        // Already handled since replacement is joined by "\n" and the original line end stays at firstRange.end.
      }
    } else {
      // drawer
      const rendered = renderDrawerLine(layout_entry.rawKey, layout_entry.indent, value)
      const r = layout_entry.lineRanges[0]
      edits.push({ start: r.start, end: r.end, replacement: rendered })
    }
  }

  // 2) Add new keys (those in newFrontmatter but not in layout).
  const additions: string[] = []
  for (const key of Object.keys(newFrontmatter)) {
    const lower = key.toLowerCase()
    if (layout.keys.has(lower)) continue
    const value = newFrontmatter[key]
    const rawKey = lower === "tags" || lower === "filetags"
      ? "FILETAGS"
      : key.toUpperCase()
    const effectiveLower = (lower === "tags") ? "filetags" : lower
    const lines = renderKeywordLines(rawKey, "", value, effectiveLower)
    additions.push(...lines)
  }

  let result = applyEdits(content, edits)

  if (additions.length) {
    // Recompute insertion offset since earlier edits may have shifted it.
    const insertOffset = recomputeKeywordInsertOffset(result)
    const block = additions.join("\n")
    if (insertOffset === 0) {
      // Insert at top. Ensure a newline separates the block from following content.
      const sep = result.length > 0 ? "\n" : ""
      result = block + sep + result
    } else {
      // insertOffset points at the newline that ends the last #+KEYWORD: line
      // (or at content.length). Inject "\n<block>" just before that newline.
      result = result.slice(0, insertOffset) + "\n" + block + result.slice(insertOffset)
    }
  }

  return result
}

function findCaseInsensitive(obj: Record<string, any>, lowerKey: string): any {
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lowerKey) return obj[k]
  }
  return undefined
}

function applyEdits(content: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  if (!edits.length) return content
  edits.sort((a, b) => a.start - b.start)
  const out: string[] = []
  let cursor = 0
  for (const e of edits) {
    if (e.start < cursor) continue   // overlapping; skip
    out.push(content.slice(cursor, e.start))
    out.push(e.replacement)
    cursor = e.end
  }
  out.push(content.slice(cursor))
  return out.join("")
}

function recomputeKeywordInsertOffset(content: string): number {
  // Find the last `#+KEYWORD:` line in the head region (before the first
  // heading). Falls back to 0 if none.
  const headingIdx = content.search(/^\*+\s/m)
  const headEnd = headingIdx < 0 ? content.length : headingIdx
  const head = content.slice(0, headEnd)
  const lines = head.split("\n")
  let offset = 0
  let lastKeywordEnd = -1
  for (const line of lines) {
    const lineStart = offset
    const lineEnd = offset + line.length
    if (/^\s*#\+[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line)) {
      lastKeywordEnd = lineEnd
    }
    offset = lineEnd + 1
  }
  return lastKeywordEnd >= 0 ? lastKeywordEnd : 0
}
