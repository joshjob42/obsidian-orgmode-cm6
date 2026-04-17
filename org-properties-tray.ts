import { Extension, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { App, TFile } from "obsidian";
import { LRParser } from "@lezer/lr";
import { extractOrgMetadata, writeOrgFrontmatter, OrgFrontmatter } from "org-metadata";

// Obsidian's MetadataEditor constructor isn't public, but we can grab it from
// an existing file-properties view. The constructor signature we rely on is
// `new MetadataEditor(app, owner)`.
type MetadataEditor = {
  containerEl: HTMLElement
  synchronize: (fm: OrgFrontmatter) => void
  load: () => void
  unload: () => void
  properties: Array<{ key: string; value: any }>
}

function getMetadataEditorCtor(app: App): any | null {
  const leaves = app.workspace.getLeavesOfType("file-properties")
  for (const leaf of leaves) {
    const view = leaf.view as any
    if (view && view.metadataEditor && view.metadataEditor.constructor) {
      return view.metadataEditor.constructor
    }
  }
  return null
}

// Per-editor holder. Owns the MetadataEditor instance so it survives widget
// re-decorations (CM can freely rebuild WidgetType instances).
class TrayHolder {
  editor: MetadataEditor | null = null
  containerEl: HTMLElement | null = null
  lastFrontmatter: OrgFrontmatter = {}
  constructor(
    public app: App,
    public parser: LRParser,
    public getFile: () => TFile | null,
  ) {}

  ensureEditor(initialFrontmatter: OrgFrontmatter): HTMLElement {
    if (this.editor && this.containerEl) {
      if (JSON.stringify(initialFrontmatter) !== JSON.stringify(this.lastFrontmatter)) {
        this.editor.synchronize(initialFrontmatter)
        this.lastFrontmatter = initialFrontmatter
      }
      return this.containerEl
    }
    const Ctor = getMetadataEditorCtor(this.app)
    const wrapper = document.createElement("div")
    wrapper.className = "org-properties-tray"
    if (!Ctor) {
      wrapper.textContent = "(properties tray unavailable — file-properties view not loaded)"
      this.containerEl = wrapper
      return wrapper
    }
    const file = this.getFile()
    const owner = {
      app: this.app,
      file,
      modifyingFile: file,
      rawFrontmatter: "",
      frontmatter: { ...initialFrontmatter },
      getFile: () => this.getFile(),
      getHoverSource: () => "",
      requestUpdate: () => {},
      saveFrontmatter: (fm: OrgFrontmatter) => {
        const f = this.getFile()
        if (!f) return
        return this.app.vault.process(f, (text: string) => {
          try {
            return writeOrgFrontmatter(this.parser, text, fm || {})
          } catch (e) {
            console.error("[orgmode-cm6] writeOrgFrontmatter failed", e)
            return text
          }
        })
      },
    }
    const me = new Ctor(this.app, owner) as MetadataEditor
    me.load && me.load()
    me.synchronize(initialFrontmatter)
    this.lastFrontmatter = initialFrontmatter
    this.editor = me
    wrapper.appendChild(me.containerEl)
    this.containerEl = wrapper
    return wrapper
  }

  destroy() {
    if (this.editor && (this.editor as any).unload) {
      try { (this.editor as any).unload() } catch (e) { /* ignore */ }
    }
    this.editor = null
    this.containerEl = null
  }
}

class OrgPropertiesWidget extends WidgetType {
  constructor(public holder: TrayHolder, public frontmatter: OrgFrontmatter) {
    super()
  }
  eq(other: OrgPropertiesWidget): boolean {
    return this.holder === other.holder &&
      JSON.stringify(this.frontmatter) === JSON.stringify(other.frontmatter)
  }
  toDOM(view: EditorView): HTMLElement {
    return this.holder.ensureEditor(this.frontmatter)
  }
  updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    this.holder.ensureEditor(this.frontmatter)
    return true
  }
  ignoreEvent(): boolean {
    return true
  }
  get estimatedHeight() { return -1 }
}

// Find the byte-range of the org frontmatter region (from offset 0 to the line
// after the last #+KEYWORD: line or :PROPERTIES: drawer, whichever is later).
// Also returns the parsed frontmatter object.
function findFrontmatterRegion(parser: LRParser, content: string): {
  range: { from: number; to: number } | null
  frontmatter: OrgFrontmatter
} {
  const meta = extractOrgMetadata(parser, content)
  const fm = meta.frontmatter || {}
  if (!meta.frontmatterPosition) return { range: null, frontmatter: fm }
  const to = meta.frontmatterPosition.end.offset
  // Extend `to` to include the trailing newline + any immediately-following blank line.
  let end = to
  if (end < content.length && content.charCodeAt(end) === 10) end++   // consume LF
  // Consume a single trailing blank line (for visual separation).
  if (end < content.length && content.charCodeAt(end) === 10) end++
  return {
    range: { from: 0, to: end },
    frontmatter: fm,
  }
}

export function orgPropertiesTray(
  app: App,
  parser: LRParser,
  getFile: () => TFile | null,
): Extension {
  const holder = new TrayHolder(app, parser, getFile)

  const buildDecorations = (content: string): DecorationSet => {
    const { range, frontmatter } = findFrontmatterRegion(parser, content)
    if (!range || Object.keys(frontmatter).length === 0) return Decoration.none
    const widget = new OrgPropertiesWidget(holder, frontmatter)
    const deco = Decoration.replace({ widget, block: true }).range(range.from, range.to)
    return Decoration.set([deco])
  }

  const trayField = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state.doc.toString())
    },
    update(value, tr) {
      if (!tr.docChanged) return value
      return buildDecorations(tr.state.doc.toString())
    },
    provide: f => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of(view => view.state.field(f)),
    ],
  })

  return trayField
}
