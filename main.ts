import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { foldGutter } from "@codemirror/language"
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { LRParser } from "@lezer/lr";
import { vim, Vim } from "@replit/codemirror-vim"

import { App, PluginSettingTab, Plugin, WorkspaceLeaf, TextFileView, Setting, parseYaml, MarkdownRenderChild, Notice } from "obsidian";

import { OrgmodeLanguage, OrgmodeParser } from 'codemirror-lang-orgmode';

import { DEFAULT_SETTINGS, OrgmodePluginSettings } from 'settings';
import { OrgmodeTask, StatusType } from 'org-tasks';
import { OrgTasksSync } from 'org-tasks-file-sync';
import { makeHeadingsFoldable, iterateOrgIds, alignTable, listAutoIndent, listIndent, listDedent, listContinueLine, toggleFoldAtCursor } from 'language-extensions';
import { orgmodeLivePreview } from "org-live-preview";
import { extractOrgMetadata, writeOrgFrontmatter, OrgCachedMetadata } from "org-metadata";
import { orgPropertiesTray } from "org-properties-tray";
import { OrgShadowIndex } from "org-shadow-index";
import { registerOrgEmbedPostProcessor } from "org-embed-renderer";
import * as crypto from "crypto";
import { Orgzly } from 'orgzly-search';
import { ConditionValue, ConditionResolver, AgendaGroup, OrgzlyView } from 'orgzly-search';
import { moment } from 'obsidian';
import { orgzlyI18n_overdue } from "orgzly-l18n";

let todoKeywordsReloader = new Compartment
let vimCompartment = new Compartment

function parseKeywordTextArea(value: string): string[] {
  return value.replace(/\n/g, ",").split(',').map(x=>x.trim()).filter(x => x != "");
}

class ConditionResolverObsidian implements ConditionResolver {
  now: number
  constructor() {
    this.now = moment().valueOf()
  }
  public safeEval(toEval: string, task: OrgmodeTask) {
      // equivalent of "return eval(toEval)"
      // but only using "task" as context
      // for example toEval="task.scheduled"
      return (new Function('task', `return ${toEval}`))(task)
  }
  resolve(value: ConditionValue, task: OrgmodeTask): string | number {
    if ('text' in value) {
      return value['text']
    }
    if ('duration' in value) {
      return moment(this.now).add(...value['duration'] as any).startOf('day').valueOf()
    }
    if ('eval' in value) {
      return this.safeEval(value['eval'], task)
    }
    if ('evalDateStartOfDay' in value) {
      const evalDateStartOfDay = this.safeEval(value['evalDateStartOfDay'], task)
      return moment(evalDateStartOfDay).startOf('day').valueOf()
    }
    if ('evalDate' in value) {
      const evalDate = this.safeEval(value['evalDate'], task)
      return moment(evalDate).valueOf()
    }
  }
  agendaFormatDate(timestamp: number | "overdue"): string {
    if (timestamp === "overdue") {
      const locale: string = moment.locale()
      if (orgzlyI18n_overdue.has(locale)) {
        return orgzlyI18n_overdue.get(locale)
      }
      return orgzlyI18n_overdue.get("default")
    }
    let localizedDate: string = moment(timestamp).format("LLLL")
    const currentYear = moment().year()
    if (moment(timestamp).year() == currentYear) {
      localizedDate = localizedDate.replace(new RegExp(`[, ]*${currentYear}.*$`), '')
    } else {
      localizedDate = localizedDate.replace(new RegExp(`${moment(timestamp).year()}.*$`), `${moment(timestamp).year()}`)
    }
    return localizedDate
  }
}

export class OrgmodeSettingTab extends PluginSettingTab {
  plugin: OrgmodePlugin;

  constructor(app: App, plugin: OrgmodePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Keywords for active (todo) tasks')
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.todoKeywords.join(","))
          .setPlaceholder('comma-separated values')
          .onChange(async (value) => {
            this.plugin.settings.todoKeywords = parseKeywordTextArea(value)
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName('Keywords for completed (done) tasks')
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.doneKeywords.join(","))
          .setPlaceholder('comma-separated values')
          .onChange(async (value) => {
            this.plugin.settings.doneKeywords = parseKeywordTextArea(value)
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName("Default priority")
      .setDesc('For sorting items without a priority')
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultPriority)
          .setPlaceholder("priority cookie like 'B'")
          .onChange(async (value) => {
            this.plugin.settings.defaultPriority = value
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName('Heading display style')
      .setDesc('How heading prefixes are displayed')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('stars', 'Show stars (* ** ***)')
          .addOption('noStars', 'Hide stars')
          .addOption('hashmarks', 'Show as # marks')
          .setValue(this.plugin.settings.headingStyle)
          .onChange(async (value: 'stars' | 'noStars' | 'hashmarks') => {
            this.plugin.settings.headingStyle = value
            this.plugin.settings.hideStars = (value !== 'stars')
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName('List bullet style')
      .setDesc('How unordered list bullets are displayed')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('dash', 'Plain dashes (- - -)')
          .addOption('unicode', 'Unicode bullets (• ◦ ▪ ▹)')
          .addOption('none', 'Hide bullets')
          .setValue(this.plugin.settings.bulletStyle)
          .onChange(async (value: 'dash' | 'unicode' | 'none') => {
            this.plugin.settings.bulletStyle = value
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName('Linkify plain URLs')
      .setDesc('Make bare URLs clickable (like Obsidian markdown). Default off preserves org-mode behavior where bare URLs are plain text.')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.linkifyPlainUrls)
          .onChange(async (value) => {
            this.plugin.settings.linkifyPlainUrls = value
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName("Dynamic block javascript definition file")
      .setDesc('Filepath of the javascript file which contains the custom functions executed in orgmode dynamic blocks')
      .addText((text) => {
        text.setValue(this.plugin.settings.dynamicBlockJsFilepath)
          .setPlaceholder("path/in/vault/to/file.js")
          .onChange(async (value) => {
            this.plugin.settings.dynamicBlockJsFilepath = value
            await this.plugin.saveSettings();
          })
      })
    new Setting(containerEl)
      .setName("Shadow markdown index")
      .setDesc("Emit companion .md files under a folder so Obsidian's full-text search and graph view see org content. Clicking a shadow opens the real .org file.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.shadowIndexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.shadowIndexEnabled = value
            await this.plugin.saveSettings();
            if (value && this.plugin.shadowIndex) {
              this.plugin.shadowIndex.syncAll().catch(e => console.error(e))
            }
          })
      })
    new Setting(containerEl)
      .setName("Shadow index folder")
      .setDesc("Folder where shadow .md files are stored. Must not start with a dot (Obsidian won't index dot-folders).")
      .addText((text) => {
        text.setValue(this.plugin.settings.shadowIndexFolder)
          .setPlaceholder("_o")
          .onChange(async (value) => {
            const cleaned = value.replace(/^\/+|\/+$/g, "").trim()
            if (!cleaned || cleaned.startsWith(".")) return
            this.plugin.settings.shadowIndexFolder = cleaned
            await this.plugin.saveSettings();
          })
      })
  }
}

export default class OrgmodePlugin extends Plugin {

  settings: OrgmodePluginSettings;
  orgmodeParser: LRParser
  settingTab: OrgmodeSettingTab = null;
  shadowIndex: OrgShadowIndex = null;

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.todoKeywords = parseKeywordTextArea(this.settings.todoKeywords.join(","))
    this.settings.doneKeywords = parseKeywordTextArea(this.settings.doneKeywords.join(","))
    const words = [...this.settings.todoKeywords, ...this.settings.doneKeywords]
    this.orgmodeParser = OrgmodeParser(words)
  }

  async saveSettings() {
    await this.saveData(this.settings);
    const view = this.app.workspace.getActiveViewOfType(OrgView)
    const words = [...this.settings.todoKeywords, ...this.settings.doneKeywords]
    this.orgmodeParser = OrgmodeParser(words)
    view.codeMirror.dispatch({
      effects: todoKeywordsReloader.reconfigure(OrgmodeLanguage(this.orgmodeParser))
    })
  }

  orgViewCreator = (leaf: WorkspaceLeaf) => {
    return new OrgView(leaf, this.orgmodeParser, this.settings);
  };

  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex")
  }

  private populateMetadataForFile = async (file: any): Promise<void> => {
    if (!file || file.extension !== "org") return
    let content: string
    try {
      content = await this.app.vault.cachedRead(file)
    } catch (e) {
      return
    }
    const metadata = extractOrgMetadata(this.orgmodeParser, content)
    const mc = this.app.metadataCache as any
    const hash = this.computeHash(content)
    if (!mc.fileCache || !mc.metadataCache) return
    mc.fileCache[file.path] = { mtime: file.stat.mtime, size: file.stat.size, hash }
    mc.metadataCache[hash] = metadata
    if (typeof mc.resolveLinks === "function") {
      try { mc.resolveLinks(file.path) } catch (e) { /* swallow */ }
    }
    mc.trigger("changed", file, content, metadata)
    mc.trigger("resolve", file)
    this.refreshPropertiesViewFor(file)
  }

  private refreshPropertiesViewFor = (file: any): void => {
    const leaves = this.app.workspace.getLeavesOfType("file-properties")
    for (const leaf of leaves) {
      const view = leaf.view as any
      if (view && view.file === file && typeof view.onFileChange === "function") {
        try { view.onFileChange(file) } catch (e) { /* swallow */ }
      }
    }
  }

  private populateAllOrgFiles = async (): Promise<void> => {
    const orgFiles = this.app.vault.getFiles().filter((f: any) => f.extension === "org")
    for (const f of orgFiles) {
      await this.populateMetadataForFile(f)
    }
  }

  private clearMetadataForFile = (file: any): void => {
    if (!file || file.extension !== "org") return
    const mc = this.app.metadataCache as any
    if (!mc.fileCache) return
    const entry = mc.fileCache[file.path]
    delete mc.fileCache[file.path]
    if (entry && entry.hash && mc.metadataCache) delete mc.metadataCache[entry.hash]
    mc.trigger("deleted", file, entry)
  }

  private patchOutlineView = (): void => {
    const patchProto = (proto: any) => {
      if (proto.__orgPatched) return
      const orig = proto.getHeadings
      proto.getHeadings = function (this: any) {
        const file = this.file
        if (file && file.extension === "org") {
          const cache = this.app.metadataCache.getCache(file.path)
          return cache?.headings || []
        }
        return orig.call(this)
      }
      proto.__orgPatched = true
      proto.__origGetHeadings = orig
      this.register(() => {
        if (proto.__orgPatched) {
          proto.getHeadings = proto.__origGetHeadings
          delete proto.__origGetHeadings
          delete proto.__orgPatched
        }
      })
    }
    const attempt = async () => {
      for (const leaf of this.app.workspace.getLeavesOfType("outline")) {
        if (typeof (leaf as any).loadIfDeferred === "function") {
          try { await (leaf as any).loadIfDeferred() } catch (e) { /* skip */ }
        }
        if (leaf.view) patchProto(Object.getPrototypeOf(leaf.view))
      }
    }
    attempt()
    this.registerEvent(this.app.workspace.on("layout-change", attempt))
    this.registerEvent(this.app.workspace.on("active-leaf-change", attempt))
  }

  private patchPropertiesView = (): void => {
    const plugin = this
    const patchProto = (proto: any) => {
      if (proto.__orgPatched) return
      const origIsSupported = proto.isSupportedFile
      const origUpdate = proto.updateFrontmatter
      const origSave = proto.saveFrontmatter
      proto.isSupportedFile = function (file: any) {
        if (file && file.extension === "org") return true
        return origIsSupported.call(this, file)
      }
      proto.updateFrontmatter = function (file: any, content: string) {
        if (file && file.extension === "org") {
          const cache = this.app.metadataCache.getCache(file.path)
          this.rawFrontmatter = ""
          this.frontmatter = cache?.frontmatter || {}
          return
        }
        return origUpdate.call(this, file, content)
      }
      proto.saveFrontmatter = function (newFrontmatter: any) {
        const file = this.file
        if (file && file.extension === "org" && file === this.modifyingFile) {
          return this.app.vault.process(file, (text: string) => {
            try {
              return writeOrgFrontmatter(plugin.orgmodeParser, text, newFrontmatter || {})
            } catch (e) {
              console.error("[orgmode-cm6] writeOrgFrontmatter failed", e)
              return text
            }
          })
        }
        return origSave.call(this, newFrontmatter)
      }
      proto.__orgPatched = true
      proto.__origIsSupportedFile = origIsSupported
      proto.__origUpdateFrontmatter = origUpdate
      proto.__origSaveFrontmatter = origSave
      plugin.register(() => {
        if (proto.__orgPatched) {
          proto.isSupportedFile = proto.__origIsSupportedFile
          proto.updateFrontmatter = proto.__origUpdateFrontmatter
          proto.saveFrontmatter = proto.__origSaveFrontmatter
          delete proto.__origIsSupportedFile
          delete proto.__origUpdateFrontmatter
          delete proto.__origSaveFrontmatter
          delete proto.__orgPatched
        }
      })
    }
    const attempt = async () => {
      for (const leaf of this.app.workspace.getLeavesOfType("file-properties")) {
        if (typeof (leaf as any).loadIfDeferred === "function") {
          try { await (leaf as any).loadIfDeferred() } catch (e) { /* skip */ }
        }
        if (leaf.view) patchProto(Object.getPrototypeOf(leaf.view))
      }
    }
    attempt()
    this.registerEvent(this.app.workspace.on("layout-change", attempt))
    this.registerEvent(this.app.workspace.on("active-leaf-change", attempt))
  }

  private patchMetadataCacheGetCache = (): void => {
    const mc = this.app.metadataCache as any
    if (mc.__orgPatched) return
    const orig = mc.getCache.bind(mc)
    mc.__orgPatched = true
    mc.__origGetCache = orig
    mc.getCache = function (path: string) {
      if (typeof path === "string" && path.toLowerCase().endsWith(".org")) {
        if (!mc.fileCache || !mc.fileCache[path]) return null
        const hash = mc.fileCache[path].hash
        return mc.metadataCache?.[hash] || null
      }
      return orig(path)
    }
    this.register(() => {
      if (mc.__orgPatched && mc.__origGetCache) {
        mc.getCache = mc.__origGetCache
        delete mc.__origGetCache
        delete mc.__orgPatched
      }
    })
  }

  private registerOrgLinkUpdater = (): void => {
    const convertToOrgLinkForm = (change: string, reference: any): string => {
      // `change` is Obsidian-formatted, e.g. `[[newpath]]` or `[[newpath|alias]]`.
      // Strip the wrapping and extract link/alias.
      const m = change.match(/^\[\[([^\]]+?)(?:\|([^\]]+))?\]\]$/)
      if (!m) return change
      const newLink = m[1]
      const obsidianAlias = m[2]
      // Org files use `[[link][display]]`. Preserve the prior display text if
      // the user had one and Obsidian didn't override it.
      const origDisplay: string | undefined = reference?.displayText
      const origRaw: string | undefined = reference?.original
      const origHadAlias = !!(origRaw && origRaw.includes(']['))
      const aliasToKeep = obsidianAlias ?? (origHadAlias ? origDisplay : undefined)
      if (aliasToKeep && aliasToKeep !== newLink) {
        return `[[${newLink}][${aliasToKeep}]]`
      }
      return `[[${newLink}]]`
    }


    const mc = this.app.metadataCache as any
    if (!mc.linkUpdaters) return
    const plugin = this
    const getLinksForPath = (path: string) => {
      const fc = mc.fileCache?.[path]
      if (!fc) return []
      const meta = mc.metadataCache?.[fc.hash]
      return meta?.links || []
    }
    mc.linkUpdaters.org = {
      app: this.app,
      iterateReferencesForFile(path: string, cb: (ref: any) => any) {
        for (const ref of getLinksForPath(path)) {
          cb(ref)
        }
      },
      iterateReferences(cb: (path: string, ref: any) => any) {
        const files = plugin.app.vault.getFiles().filter((f: any) => f.extension === "org")
        for (const f of files) {
          for (const ref of getLinksForPath(f.path)) {
            cb(f.path, ref)
          }
        }
      },
      async applyUpdates(file: any, updates: Array<{ reference: any; change: string }>) {
        if (!updates || !updates.length) return
        await plugin.app.vault.process(file, (text: string) => {
          const seen = new Set<string>()
          const edits: Array<{ start: number; end: number; text: string }> = []
          for (const u of updates) {
            if (!u.reference || !u.reference.position) continue
            let start = u.reference.position.start.offset
            let end = u.reference.position.end.offset
            const original: string | undefined = u.reference.original
            // The cached positions may be stale relative to the current text
            // (e.g. file was just edited externally). Validate and relocate.
            if (original) {
              if (text.substring(start, end) !== original) {
                const idx = text.indexOf(original)
                if (idx < 0) continue   // can't find the link — skip
                start = idx
                end = idx + original.length
              }
            }
            const key = `${start}-${end}`
            if (seen.has(key)) continue
            seen.add(key)
            const replacement = convertToOrgLinkForm(u.change, u.reference)
            edits.push({ start, end, text: replacement })
          }
          edits.sort((a, b) => b.start - a.start)
          for (const e of edits) {
            text = text.substring(0, e.start) + e.text + text.substring(e.end)
          }
          return text
        })
      },
      renameSubpath(_oldPath: string, _newPath: string, _subpath: string) { /* no-op */ },
    }
  }

  async onload() {
    await this.loadSettings();
    this.settingTab = new OrgmodeSettingTab(this.app, this)
    this.addSettingTab(this.settingTab);

    this.registerView("orgmode", this.orgViewCreator);
    this.registerExtensions(["org"], "orgmode");
    this.patchMetadataCacheGetCache()
    this.registerOrgLinkUpdater()
    this.app.workspace.onLayoutReady(() => {
      this.patchOutlineView()
      this.patchPropertiesView()
    })

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if ((file as any).extension === "org") this.populateMetadataForFile(file)
    }))
    this.registerEvent(this.app.vault.on("create", (file) => {
      if ((file as any).extension === "org") this.populateMetadataForFile(file)
    }))
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if ((file as any).extension === "org") this.clearMetadataForFile(file)
    }))
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if ((file as any).extension === "org") {
        const mc = this.app.metadataCache as any
        if (mc.fileCache && mc.fileCache[oldPath]) {
          mc.fileCache[file.path] = mc.fileCache[oldPath]
          delete mc.fileCache[oldPath]
        }
        this.populateMetadataForFile(file)
      }
    }))
    this.app.workspace.onLayoutReady(() => { this.populateAllOrgFiles() })

    this.shadowIndex = new OrgShadowIndex(
      this.app,
      this.orgmodeParser,
      this.settings,
      (cb) => this.register(cb),
    )
    this.shadowIndex.onload().catch(e => console.error("[orgmode-cm6] shadow init", e))

    this.addCommand({
      id: "rebuild-shadow-index",
      name: "Rebuild shadow index",
      callback: async () => {
        if (!this.shadowIndex) return
        new Notice("Rebuilding shadow index…")
        try {
          await this.shadowIndex.rebuildAll()
          new Notice("Shadow index rebuilt.")
        } catch (e) {
          console.error("[orgmode-cm6] rebuild shadow", e)
          new Notice("Shadow rebuild failed — see console.")
        }
      },
    })

    registerOrgEmbedPostProcessor(this)

    this.registerMarkdownCodeBlockProcessor("orgmode-tasks", async (src, el, ctx) => {
      try {
        let parameters = null;
        parameters = parseYaml(src)
        if (typeof parameters.filepath === 'undefined') {
          throw Error("Missing parameters filepath")
        }
        const tfile = this.app.vault.getFileByPath(parameters.filepath)
        if (!tfile) {
          throw Error(`file not found: ${parameters.filepath}`)
        }
        let orgzlyExpression = "it.todo or it.done"  // backward compatibility
        if (typeof parameters.query !== 'undefined') {
          orgzlyExpression = parameters.query
        }
        const orgTasksSync = new OrgTasksSync(this.settings, this.orgmodeParser, this.app.vault)
        const rootEl = el.createEl("div");
        const renderChild = new MarkdownRenderChild(el)
        ctx.addChild(renderChild);
        renderChild.unload = () => {
          orgTasksSync.onunload()
        }
        const onStatusChange = async (orgmode_task: OrgmodeTask) => {
          await orgTasksSync.updateTaskStatus(tfile, orgmode_task)
        }
        const initial_orgmode_tasks: Array<OrgmodeTask> = await orgTasksSync.getTasks(tfile)
        const resolver = new ConditionResolverObsidian()
        const orgzly = new Orgzly(this.settings, resolver)
        const orgzly_view = orgzly.search(orgzlyExpression, initial_orgmode_tasks)
        this.render(rootEl, orgzly_view, onStatusChange, resolver)
        orgTasksSync.onmodified(tfile, (refreshed_tasks: OrgmodeTask[]) => {
          const refreshed_orgzly_view = orgzly.search(orgzlyExpression, refreshed_tasks)
          this.render(rootEl, refreshed_orgzly_view, onStatusChange, resolver)
        })
      } catch (e) {
          el.createEl("h3", {text: "Error: " + e.message});
        return;
      }
    });
  }

  private render(
    rootEl: HTMLElement,
    orgzlyView: OrgzlyView,
    onStatusChange: (orgmode_task: OrgmodeTask) => void,
    resolver: ConditionResolver,
  ) {
    rootEl.innerHTML = ""
    if ('agendaView' in orgzlyView) {
      const agenda_tasks = orgzlyView.agendaView
      this.renderAgenda(rootEl, agenda_tasks, onStatusChange, resolver)
      return
    }
    if ('regularView' in orgzlyView) {
      const orgmode_tasks = orgzlyView.regularView
      this.renderTaskList(rootEl, orgmode_tasks, onStatusChange)
      return
    }
  }

  private renderTaskList(rootEl: HTMLElement, orgmode_tasks: OrgmodeTask[], onStatusChange: (orgmode_task: OrgmodeTask) => void) {
    const list = rootEl.createEl("ul");
    if (orgmode_tasks.length === 0) {
        rootEl.createDiv({ text: 'Your search did not match any notes' })
        return
    }
    orgmode_tasks.forEach((orgmode_task) => {
      const li = list.createEl("li", {cls: "org-agenda-item"})
      const taskMainLineDiv = li.createDiv({ cls: "org-agenda-item-line" })
      this.renderTaskMainLine(taskMainLineDiv, orgmode_task, onStatusChange)
    })
  }

  private renderAgenda(rootEl: HTMLElement, agenda_groups: AgendaGroup[], onStatusChange: (orgmode_task: OrgmodeTask) => void, resolver: ConditionResolver) {
    const orgAgendaEl = rootEl.createDiv({ cls: "org-agenda" })
    agenda_groups.forEach((agenda_groups) => {
      orgAgendaEl.createDiv({ cls: "org-agenda-group-heading", text: resolver.agendaFormatDate(agenda_groups.date) })
      const list = orgAgendaEl.createEl("ul");
      agenda_groups.tasks.forEach(({task, sortKey}) => {
        const orgmode_task = task
        const li = list.createEl("li", {cls: "org-agenda-item"})
        const taskMainLineDiv = li.createDiv({ cls: "org-agenda-item-line" })
        this.renderTaskMainLine(taskMainLineDiv, orgmode_task, onStatusChange)
        const taskAttributeLineDiv = li.createDiv({ cls: "org-agenda-item-line" })
        taskAttributeLineDiv.createDiv({ cls: "org-agenda-item-gutter" })
        taskAttributeLineDiv.createDiv({ cls: `org-agenda-item-date org-agenda-item-date-${sortKey}`, text: `${resolver.safeEval(`task.${sortKey}`, task)}` })
      })
    })
  }

  private renderTaskMainLine(taskMainLineDiv: HTMLElement, orgmode_task: OrgmodeTask, onStatusChange: (orgmode_task: OrgmodeTask) => void) {
      const gutter = taskMainLineDiv.createDiv({ cls: "org-agenda-item-gutter" })
      if (orgmode_task.statusType === StatusType.DONE) {
        // data-task and checked are needed for native checkbox styling
        const input = gutter.createEl("input", { cls: "org-agenda-item-input", attr: {"data-task": "x"}, type: "checkbox" })
        input.checked = true
        input.addEventListener('click', e => {
          onStatusChange(orgmode_task)
        })
      } else if (orgmode_task.statusType === StatusType.TODO) {
        // data-task and checked are needed for native checkbox styling
        const input = gutter.createEl("input", { cls: "org-agenda-item-input", attr: {"data-task": " "}, type: "checkbox" })
        input.checked = false
        input.addEventListener('click', e => {
          onStatusChange(orgmode_task)
        })
      }
      taskMainLineDiv.createSpan({ text: orgmode_task.description })
  }
}


class OrgView extends TextFileView {
  // Internal code mirror instance:
  codeMirror: EditorView;
  extensions: Extension[];

  constructor(leaf: WorkspaceLeaf, orgmodeParser: LRParser, settings: OrgmodePluginSettings) {
    super(leaf);
    this.codeMirror = new EditorView({
      parent: this.contentEl
    })
    this.extensions = [
        history(),
        // @ts-expect-error, not typed
        vimCompartment.of((this.app.vault.getConfig("vimMode")) ? vim() : []),
        keymap.of([
          { key: "Tab", run: alignTable },
          { key: "Tab", run: listIndent },
          { key: "Shift-Tab", run: listDedent },
          { key: "Enter", run: listAutoIndent },
          { key: "Shift-Enter", run: listContinueLine },
          { key: "Alt-Shift-Tab", run: toggleFoldAtCursor },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        todoKeywordsReloader.of(OrgmodeLanguage(orgmodeParser)),
        EditorView.lineWrapping,
        makeHeadingsFoldable,
        foldGutter({
          markerDOM: (open) => {
            // icon copied from obsidian minimal theme
            const foldIcon = document.createElement("div");
            const foldIcon_svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            const foldIcon_svg_path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            foldIcon_svg.setAttributeNS(null, "width", "24");
            foldIcon_svg.setAttributeNS(null, "height", "24");
            foldIcon_svg.setAttributeNS(null, "viewBox", "0 0 24 24");
            foldIcon_svg.setAttributeNS(null, "fill", "none");
            foldIcon_svg.setAttributeNS(null, "stroke", "currentColor");
            foldIcon_svg.setAttributeNS(null, "stroke-width", "2");
            foldIcon_svg.setAttributeNS(null, "stroke-linecap", "round");
            foldIcon_svg.setAttributeNS(null, "stroke-linejoin", "round");
            foldIcon_svg.setAttributeNS(null, "class", "svg-icon");
            foldIcon_svg_path.setAttribute("d", "M3 8L12 17L21 8");
            foldIcon_svg.appendChild(foldIcon_svg_path);
            foldIcon_svg.setCssStyles({ "height": "100%" });
            if (open) {
              foldIcon.addClass("open-fold-icon");
            } else {
              foldIcon.addClass("closed-fold-icon");
              foldIcon_svg.setCssStyles({ "transform": "rotate(-90deg)", "color": "var(--text-accent)" });
            }
            foldIcon.appendChild(foldIcon_svg);
            foldIcon.setCssStyles({ "height": "100%" });
            return foldIcon
          }
        }),
        EditorView.editorAttributes.of({ class: "orgmode-view" }),
        EditorView.editorAttributes.of({ class: "mod-cm6" }),
        EditorView.baseTheme({
          ".cm-gutters": {
            backgroundColor: "unset !important",
            border: "unset !important",
          },
          ".open-fold-icon": {
            opacity: "0",
          },
          ".open-fold-icon:hover": {
            opacity: "1",
          },
          ".cm-panels": {
            backgroundColor: "#2e2e2e",
          },
        }),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) {
            this.requestSave()
          }
          if (v.focusChanged) {
            const compartmentState = vimCompartment.get(this.codeMirror.state) as Array<any>
            const loaded = !!(Array.isArray(compartmentState) && compartmentState.length)
            // @ts-expect-error, not typed
            const userset = !!this.app.vault.getConfig("vimMode")
            if (userset && !loaded) {
              this.codeMirror.dispatch({
                effects: vimCompartment.reconfigure(vim())
              })
            }
            if (!userset && loaded) {
              this.codeMirror.dispatch({
                effects: vimCompartment.reconfigure([])
              })
            }
          }
        }),
        orgmodeLivePreview(
          this.codeMirror,
          settings,
          {
          navigateToFile: (filePath: string) => {
            try {
              let tfile = this.app.metadataCache.getFirstLinkpathDest(filePath, ".");
              if (!tfile) {
                tfile = this.app.metadataCache.getFirstLinkpathDest(filePath+".org", ".");
              }
              this.leaf.openFile(tfile)
            } catch {
              return
            }
          },
          getImageUri: (linkPath: string) => {
            try {
              let imageFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, ".");
              let browserUri = this.app.vault.getResourcePath(imageFile)
              return browserUri
            } catch {
              return null
            }
          },
          navigateToOrgId: async (orgCustomId: string) => {
            try {
              const orgFiles = this.app.vault.getFiles().filter(x => x.extension == 'org')
              for (const orgFile of orgFiles) {
                const orgContent = await this.app.vault.cachedRead(orgFile)
                for (const {orgId, start} of iterateOrgIds(orgmodeParser, orgContent)) {
                  if (orgCustomId === orgId) {
                    this.leaf.openFile(orgFile).then(() => {
                      this.codeMirror.focus()
                      this.codeMirror.dispatch(
                        { selection: { head: start, anchor: start } },
                        { effects: EditorView.scrollIntoView(start, { y: "start" }) }
                      )
                    })
                    return
                  }
                }
              }
              new Notice(`Cannot find entry with ID "${orgCustomId}"`)
            } catch (e) {
              console.log(e)
              return
            }
          },
          getVaultFiles: () => {
            try {
              const orgFiles = this.app.vault.getFiles().map(x => [x.name, x.path])
              return orgFiles
            } catch (e) {
              console.log(e)
              return
            }
          },
          getLinkSuggestions: () => {
            try {
              return (this.app.metadataCache as any).getLinkSuggestions()
            } catch (e) {
              console.log(e)
              return []
            }
          },
          listOrgIds: async () => {
            try {
              const orgFiles = this.app.vault.getFiles().filter(x => x.extension == 'org')
              const orgIds = []
              for (const orgFile of orgFiles) {
                const orgContent = await this.app.vault.cachedRead(orgFile)
                for (const orgid of Array.from(iterateOrgIds(orgmodeParser, orgContent)).map(x => x.orgId)) {
                  orgIds.push([orgid, orgFile.path])
                }
              }
              return orgIds
            } catch (e) {
              console.log(e)
              return
            }
          },
          readFileContent: async (filePath: string) => {
            const tfile = this.app.vault.getFileByPath(filePath)
            if (!tfile) {
                throw Error(`File not found: ${filePath}`)
            }
            return await this.app.vault.read(tfile)
          },
          triggerHoverLink: (payload: { event: MouseEvent; linktext: string; targetEl: HTMLElement; sourcePath: string }) => {
            ;(this.app.workspace as any).trigger("hover-link", {
              event: payload.event,
              source: "orgmode",
              hoverParent: this,
              linktext: payload.linktext,
              targetEl: payload.targetEl,
              sourcePath: payload.sourcePath,
            })
          },
          getSourcePath: () => this.file?.path ?? "",
        }),
        orgPropertiesTray(this.app, orgmodeParser, () => this.file),
      ]
    Vim.defineEx('write', 'w', () => {
        this.save()
      });
  }

  getViewData = () => {
    return this.codeMirror.state.doc.toString()
  };

  setViewData = (data: string, clear: boolean) => {
    this.codeMirror.setState(EditorState.create({
      doc: data,
      extensions: this.extensions,
    }))
  }

  clear = () => {
  };

  // Scroll to a heading or anchor after navigation via [[file#Heading]].
  // Called by Obsidian's link-opening flow with eState.subpath = "#Heading".
  setEphemeralState(state: any): void {
    super.setEphemeralState(state)
    const subpath = state?.subpath
    if (!subpath || typeof subpath !== "string") return
    const target = subpath.replace(/^#+/, "").trim()
    if (!target) return
    const content = this.codeMirror.state.doc.toString()
    // Try exact-text heading match (case-insensitive, trimmed).
    const lines = content.split("\n")
    let pos = 0
    for (const line of lines) {
      const m = line.match(/^(\*+)\s+(.*?)\s*(?::[\w@%:#]+:)?\s*$/)
      if (m) {
        const title = m[2].replace(/^(?:TODO|DONE|[A-Z]{2,}|\[#[A-Z]\])\s+/g, "").trim()
        if (title.toLowerCase() === target.toLowerCase()) {
          this.codeMirror.dispatch({
            selection: { head: pos, anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "start" }),
          })
          this.codeMirror.focus()
          return
        }
      }
      pos += line.length + 1
    }
  }

  getDisplayText() {
    if (this.file) {
      return this.file.basename;
    } else {
      return "org (No File)";
    }
  }

  canAcceptExtension(extension: string) {
    return extension === "org";
  }

  getViewType() {
    return "orgmode";
  }
}
