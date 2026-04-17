import {
  Extension,
  StateField,
  Transaction,
  RangeSet,
  EditorState,
  Range,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { TOKEN } from 'codemirror-lang-orgmode';
import { extractLinkFromNode, nodeTypeClass } from 'language-extensions';
import { OrgmodePluginSettings, BULLET_CHARS } from "settings";
import { SyntaxNode } from "@lezer/common"
import { CompletionContext, CompletionResult, autocompletion } from "@codemirror/autocomplete"

class ImageWidget extends WidgetType {
  path: string
  getImageUri: (linkPath: string) => string
  constructor(path: string, getImageUri: (linkPath: string) => string) {
    super()
    this.path = path
    this.getImageUri = getImageUri
  }
  eq(other: ImageWidget) {
    return this.path == other.path
  }
  toDOM(view: EditorView): HTMLElement {
    const image = document.createElement("img");
    const obsidianPath = this.getImageUri(this.path)
    if (obsidianPath) {
      image.src = this.getImageUri(this.path)
    } else {
      image.src = this.path
    }
    return image
  }
}

class TableWidget extends WidgetType {
  tableText: string
  tableFrom: number
  constructor(tableText: string, tableFrom: number) {
    super()
    this.tableText = tableText
    this.tableFrom = tableFrom
  }
  eq(other: TableWidget) {
    return this.tableText === other.tableText
  }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "org-table-widget-wrapper"
    wrapper.style.cursor = "text"
    const tableFrom = this.tableFrom
    wrapper.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement
      // Find which row and column was clicked
      let targetRow = 0
      let targetCol = 0
      const td = target.closest("td, th")
      const tr = target.closest("tr")
      if (tr) {
        const rows = Array.from(wrapper.querySelectorAll("tr"))
        const idx = rows.indexOf(tr)
        if (idx >= 0) targetRow = idx
        if (td) {
          const cells = Array.from(tr.querySelectorAll("td, th"))
          const cidx = cells.indexOf(td as HTMLTableCellElement)
          if (cidx >= 0) targetCol = cidx
        }
      }
      // Map visual row index to source line (skip hrule lines)
      const sourceLines = this.tableText.split('\n').filter(l => l.trim().length > 0)
      let dataRowIndex = 0
      let targetLine = sourceLines[0] || ''
      let targetLineOffset = 0
      for (let i = 0; i < sourceLines.length; i++) {
        const isHruleLine = /^\s*\|[-+| ]+\|?\s*$/.test(sourceLines[i])
        if (!isHruleLine) {
          if (dataRowIndex === targetRow) {
            targetLine = sourceLines[i]
            targetLineOffset = this.tableText.indexOf(sourceLines[i])
            break
          }
          dataRowIndex++
        }
      }
      // Find the end of the target column's content within the source line
      let colOffset = 0
      let pipeCount = 0
      for (let j = 0; j < targetLine.length; j++) {
        if (targetLine[j] === '|') {
          pipeCount++
          if (pipeCount === targetCol + 2) {
            // Position cursor before this pipe, skipping trailing spaces
            colOffset = j - 1
            while (colOffset > 0 && targetLine[colOffset] === ' ') {
              colOffset--
            }
            colOffset++ // position after last non-space char
            break
          }
        }
      }
      const targetPos = tableFrom + targetLineOffset + colOffset
      e.preventDefault()
      view.dispatch({ selection: { anchor: targetPos } })
      view.focus()
    })
    const table = document.createElement("table");
    table.className = "org-table-widget"

    const lines = this.tableText.split('\n').filter(l => l.trim().length > 0)
    const isHrule = (line: string) => /^\s*\|[-+| ]+\|?\s*$/.test(line)

    // Parse all data rows to detect numeric columns
    const dataRows: string[][] = []
    for (const line of lines) {
      if (isHrule(line)) continue
      const cells = line.split('|').slice(1)
      // Remove trailing empty element from final |
      if (cells.length > 0 && cells[cells.length - 1].trim() === '') {
        cells.pop()
      }
      dataRows.push(cells.map(c => c.trim()))
    }

    const maxCols = Math.max(...dataRows.map(r => r.length), 0)
    const colNumeric: boolean[] = new Array(maxCols).fill(true)
    for (const row of dataRows) {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '' && !/^-?\d+(\.\d+)?$/.test(row[c])) {
          colNumeric[c] = false
        }
      }
    }

    // First data row before any hrule is the header
    let foundHrule = false
    let isFirstRow = true
    for (const line of lines) {
      if (isHrule(line)) {
        foundHrule = true
        continue
      }
      const cells = line.split('|').slice(1)
      if (cells.length > 0 && cells[cells.length - 1].trim() === '') {
        cells.pop()
      }

      const tr = document.createElement("tr")
      const useHeader = isFirstRow && !foundHrule
      // If first hrule comes right after first row, treat first row as header
      const isHeader = isFirstRow && lines.length > 1 && isHrule(lines[1])

      for (let c = 0; c < cells.length; c++) {
        const cellContent = cells[c].trim()
        const cellEl = document.createElement(isHeader ? "th" : "td")
        if (colNumeric[c] && !isHeader) {
          cellEl.className = "org-table-cell-numeric"
        }
        // Apply inline markup rendering
        cellEl.innerHTML = this.renderCellMarkup(cellContent)
        tr.appendChild(cellEl)
      }
      table.appendChild(tr)
      isFirstRow = false
    }

    wrapper.appendChild(table)
    return wrapper
  }

  private renderCellMarkup(text: string): string {
    // Links: [[url][desc]] → desc as link, [[url]] → url as link
    text = text.replace(/\[\[([^\]]+?)\]\[([^\]]+?)\]\]/g, '<a href="#">$2</a>')
    text = text.replace(/\[\[([^\]]+?)\]\]/g, '<a href="#">$1</a>')
    // Bold
    text = text.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, '<strong>$1</strong>')
    // Italic
    text = text.replace(/\/([^\s/](?:[^/]*[^\s/])?)\//g, '<em>$1</em>')
    // Underline
    text = text.replace(/_([^\s_](?:[^_]*[^\s_])?)_/g, '<u>$1</u>')
    // Strikethrough
    text = text.replace(/\+([^\s+](?:[^+]*[^\s+])?)\+/g, '<s>$1</s>')
    // Code
    text = text.replace(/=([^\s=](?:[^=]*[^\s=])?)=/g, '<code>$1</code>')
    // Verbatim/commands
    text = text.replace(/~([^\s~](?:[^~]*[^\s~])?)~/g, '<code>$1</code>')
    return text
  }
}

class BulletWidget extends WidgetType {
  bulletChar: string
  constructor(bulletChar: string) {
    super()
    this.bulletChar = bulletChar
  }
  eq(other: BulletWidget) {
    return this.bulletChar === other.bulletChar
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span")
    span.className = "org-bullet"
    span.textContent = this.bulletChar + " "
    return span
  }
}

class CheckboxWidget extends WidgetType {
  checked: string  // " ", "X", or "-"
  constructor(checked: string) {
    super()
    this.checked = checked
  }
  eq(other: CheckboxWidget) {
    return this.checked == other.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox"
    input.className = "org-checkbox task-list-item-checkbox"
    if (this.checked === "X") {
      input.checked = true
    } else if (this.checked === "-") {
      input.indeterminate = true
    }
    input.addEventListener("mousedown", (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = view.posAtDOM(input)
      if (pos < 0) return
      const charPos = pos + 1  // skip past the '[' to the state character
      const current = view.state.doc.sliceString(charPos, charPos + 1)
      const next = current === " " ? "X" : " "
      view.dispatch({
        changes: { from: charPos, to: charPos + 1, insert: next },
      })
    })
    return input
  }
  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown" || event.type === "click"
  }
}

class HorizontalRuleWidget extends WidgetType {
  eq(other: HorizontalRuleWidget) {
    return true
  }
  toDOM(view: EditorView): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "org-horizontal-rule"
    return hr
  }
}

class DynamicBlockWidget extends WidgetType {
  dynamicBlockParams: string
  dynamicBlockJsFilepath: string
  readFileContent: (filePath: string) => Promise<any>
  constructor(
    dynamicBlockParams: string,
    dynamicBlockJsFilepath: string,
    readFileContent: (filePath: string) => Promise<any>,
  ) {
    super()
    this.dynamicBlockParams = dynamicBlockParams
    this.dynamicBlockJsFilepath = dynamicBlockJsFilepath
    this.readFileContent = readFileContent
  }
  eq(other: DynamicBlockWidget) {
    return this.dynamicBlockParams == other.dynamicBlockParams
  }
  toDOM(view: EditorView): HTMLElement {
    const functionName = this.dynamicBlockParams.split(' ')[0]
    const block = document.createElement('div')
    block.textContent = `Loading...`
    block.contentEditable = "false"
    block.addClass("org-block")
    block.addClass("org-block-dynamic-content")
    if (!this.dynamicBlockJsFilepath) {
      block.textContent = "Error: 'Dynamic block javascript definition file' is not set in the Orgmode (cm6) plugin settings"
      return block
    }
    if (!this.dynamicBlockParams) {
      block.textContent = "Error: No params provided after '#+BEGIN:'"
      return block
    }
    this.readFileContent(this.dynamicBlockJsFilepath).then(jsFileContent => {
      let content = ''
      try {
        // Execute the function from the js file
        content = (new Function(`${jsFileContent}\nreturn ${functionName}()`))()
      } catch {
        content = `Error: Failed to load function ${functionName} from ${this.dynamicBlockJsFilepath}`
      }
      block.textContent = content
    }).catch(error => {
      block.textContent = error
    })
    return block;
  }
}

function isNodeOrgLanguage(node: SyntaxNode) {
  // A token id like TOKEN.Block could match a token of a sublanguage
  if (node.type.id === TOKEN.Block &&
      node.parent &&
    (
      node.parent.type.id === TOKEN.Section ||
      node.parent.type.id === TOKEN.ZerothSection
  )) {
    return true
  }
  if ((
      node.type.id === TOKEN.BlockHeader ||
      node.type.id === TOKEN.BlockContentDynamic ||
      node.type.id === TOKEN.BlockContentCenter ||
      node.type.id === TOKEN.BlockContentQuote ||
      node.type.id === TOKEN.BlockContentComment ||
      node.type.id === TOKEN.BlockContentExample ||
      node.type.id === TOKEN.BlockContentExport ||
      node.type.id === TOKEN.BlockContentSrc ||
      node.type.id === TOKEN.BlockContentVerse ||
      node.type.id === TOKEN.BlockContentSpecial ||
      node.type.id === TOKEN.BlockFooter
    ) && node.parent && node.parent.type.id === TOKEN.Block
  ) {
    return true
  }

  while (node) {
    if (node.type.id === TOKEN.Block) {
      return false
    }
    node = node.parent
  }
  return true
}

function tokenStartSide(node_type_id: number) {
  // bigger startSide decorations are nested inside
  // lower startSide decorations
  switch(node_type_id) {
    case TOKEN.Heading:
      return 35
    case TOKEN.Section:
    case TOKEN.ZerothSection:
      return 40
    case TOKEN.Block:
      return 45
    default:
      return 50
  }
}

function buildRange(
  from: number,
  to: number,
  decoration: Decoration,
  startSide: number,
): Range<Decoration> {
  decoration.startSide = startSide
  return decoration.range(from, to)
}

function isNodeSelected(selection: {from: number, to: number}, node: {from: number, to: number}) {
  return (
      // selection starts inside node
      (selection.from >= node.from && selection.from <= node.to) ||
      // selection ends inside node
      (selection.to >= node.from && selection.to <= node.to) ||
      // selection is bigger than node
      (selection.from < node.from && selection.to > node.to))
}

const markupPatterns: [RegExp, string][] = [
  [/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "org-text-bold"],
  [/\/([^\s/](?:[^/]*[^\s/])?)\/(?=[^a-zA-Z0-9]|$)/g, "org-text-italic"],
  [/_([^\s_](?:[^_]*[^\s_])?)_/g, "org-text-underline"],
  [/\+([^\s+](?:[^+]*[^\s+])?)\+/g, "org-text-strikethrough"],
  [/=([^\s=](?:[^=]*[^\s=])?)=/g, "org-text-verbatim"],
  [/~([^\s~](?:[^~]*[^\s~])?)~/g, "org-text-code"],
]

const linkPattern = /\[\[([^\]]+?)(?:\]\[([^\]]+?))?\]\]/g
const plainUrlPattern = /\bhttps?:\/\/[^\s<>\])}]+/g

function applyInlineMarkup(
  text: string,
  baseFrom: number,
  hideMarkers: boolean,
  startSide: number,
  builderBuffer: Array<Range<Decoration>>,
  linkifyPlainUrls: boolean = false,
) {
  // Apply text markup patterns
  for (const [pattern, cssClass] of markupPatterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const matchStart = baseFrom + match.index
      const matchEnd = matchStart + match[0].length
      if (hideMarkers) {
        builderBuffer.push(buildRange(matchStart, matchStart + 1, Decoration.replace({}), startSide))
        builderBuffer.push(buildRange(matchEnd - 1, matchEnd, Decoration.replace({}), startSide))
      }
      builderBuffer.push(buildRange(matchStart, matchEnd, Decoration.mark({class: cssClass}), startSide))
    }
  }
  // Apply link patterns
  linkPattern.lastIndex = 0
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkPattern.exec(text)) !== null) {
    const matchStart = baseFrom + linkMatch.index
    const matchEnd = matchStart + linkMatch[0].length
    if (hideMarkers) {
      if (linkMatch[2]) {
        // [[url][desc]] — hide [[url][ and ]]
        const descStart = matchStart + linkMatch[0].indexOf('][') + 2
        builderBuffer.push(buildRange(matchStart, descStart, Decoration.replace({}), startSide))
        builderBuffer.push(buildRange(descStart, matchEnd - 2, Decoration.mark({tagName: "a", attributes: { href: "#" }}), startSide))
        builderBuffer.push(buildRange(matchEnd - 2, matchEnd, Decoration.replace({}), startSide))
      } else {
        // [[url]] — hide [[ and ]]
        builderBuffer.push(buildRange(matchStart, matchStart + 2, Decoration.replace({}), startSide))
        builderBuffer.push(buildRange(matchStart + 2, matchEnd - 2, Decoration.mark({tagName: "a", attributes: { href: "#" }}), startSide))
        builderBuffer.push(buildRange(matchEnd - 2, matchEnd, Decoration.replace({}), startSide))
      }
    } else {
      builderBuffer.push(buildRange(matchStart, matchEnd, Decoration.mark({class: "org-link"}), startSide))
    }
  }
  // Apply plain URL linkification (gated by setting; skips URLs inside [[...]])
  if (linkifyPlainUrls) {
    const bracketedRanges: Array<[number, number]> = []
    linkPattern.lastIndex = 0
    let bm: RegExpExecArray | null
    while ((bm = linkPattern.exec(text)) !== null) {
      bracketedRanges.push([bm.index, bm.index + bm[0].length])
    }
    plainUrlPattern.lastIndex = 0
    let um: RegExpExecArray | null
    while ((um = plainUrlPattern.exec(text)) !== null) {
      const start = um.index
      const end = start + um[0].length
      const inBracket = bracketedRanges.some(([bs, be]) => start >= bs && end <= be)
      if (inBracket) continue
      const url = um[0]
      builderBuffer.push(buildRange(
        baseFrom + start,
        baseFrom + end,
        Decoration.mark({
          tagName: "a",
          class: "org-link",
          attributes: { href: "#", "data-plain-url": url },
        }),
        startSide,
      ))
    }
  }
}

function loadDecorations(
  state: EditorState,
  settings: OrgmodePluginSettings,
  obsidianUtils: {
    navigateToFile: (filePath: string) => void,
    getImageUri: (linkPath: string) => string,
    navigateToOrgId: (orgCustomId: string) => void,
    readFileContent: (filePath: string) => Promise<any>
}) {
  const builderBuffer = new Array<Range<Decoration>>
  const selectionPos = state.selection.main
  syntaxTree(state).iterate({
    enter(node) {
      const nodeIsSelected = isNodeSelected(selectionPos, node)
      const nodeIsOrgLang = isNodeOrgLanguage(node.node)
      if (nodeIsOrgLang && node.type.id === TOKEN.Block) {
        const firstLine = state.doc.lineAt(node.from)
        const lastLine = state.doc.lineAt(node.to-1)
        for (let i = firstLine.number; i <= lastLine.number; ++i) {
          const line = state.doc.line(i)
          builderBuffer.push(
            buildRange(
              line.from,
              line.from,
              Decoration.line({class: nodeTypeClass(node.type.id)}),
              tokenStartSide(node.type.id),
            )
          )
        }
        const blockFirstLine = state.doc.sliceString(firstLine.from, firstLine.to).trim()
        const isDynamicBlock = blockFirstLine.toUpperCase().startsWith("#+BEGIN:")
        const firstLineIsSelected = isNodeSelected(selectionPos, firstLine)
        if (!firstLineIsSelected) {
          builderBuffer.push(
            buildRange(
              firstLine.from,
              firstLine.from+"#+BEGIN_".length,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
          if (firstLine.from+"#+BEGIN_".length != firstLine.to) {
            builderBuffer.push(
              buildRange(
                firstLine.from+"#+BEGIN_".length,
                firstLine.to,
                Decoration.mark({class: "org-block-header"}),
                tokenStartSide(node.type.id),
              )
            )
            if (isDynamicBlock) {
              builderBuffer.push(
                buildRange(
                  firstLine.from+"#+BEGIN_".length,
                  firstLine.to,
                  Decoration.mark({class: "org-block-header-dynamic"}),
                  tokenStartSide(node.type.id),
                )
              )
            }
          }
        }
        const lastLineIsSelected = isNodeSelected(selectionPos, lastLine)
        if (!lastLineIsSelected) {
          builderBuffer.push(
            buildRange(
              lastLine.from,
              lastLine.to,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        }
        if (isDynamicBlock && !firstLineIsSelected) {
          const dynamicBlockParams = blockFirstLine.slice("#+BEGIN:".length).trim()
          builderBuffer.push(
            buildRange(
              firstLine.to,
              firstLine.to,
              Decoration.widget({
                widget: new DynamicBlockWidget(
                  dynamicBlockParams,
                  settings.dynamicBlockJsFilepath,
                  obsidianUtils.readFileContent,
                ),
                block: false,
              }),
              tokenStartSide(node.type.id),
            )
          )
        }
        // Apply inline markup inside QUOTE and VERSE blocks
        const blockType = blockFirstLine.toUpperCase()
        const isFormattedBlock = blockType.startsWith("#+BEGIN_QUOTE") || blockType.startsWith("#+BEGIN_VERSE")
        if (isFormattedBlock) {
          // Apply markup to content lines (between first and last line)
          for (let i = firstLine.number + 1; i < lastLine.number; ++i) {
            const contentLine = state.doc.line(i)
            const lineIsSelected = isNodeSelected(selectionPos, contentLine)
            const lineText = state.doc.sliceString(contentLine.from, contentLine.to)
            applyInlineMarkup(
              lineText,
              contentLine.from,
              !lineIsSelected,
              tokenStartSide(node.type.id),
              builderBuffer,
              settings.linkifyPlainUrls,
            )
          }
        }
      } else if (
        nodeIsOrgLang && (
          node.type.id === TOKEN.PlainLink ||
          node.type.id === TOKEN.RegularLink ||
          node.type.id === TOKEN.AngleLink
        )
      ) {
        const linkText = state.doc.sliceString(node.from, node.to)
        const [linkPath, displayText, linkHandler, displayTextFromOffset] = extractLinkFromNode(node.type.id, linkText)
        if (linkHandler === "internal-inline-image") {
          if (nodeIsSelected) {
            builderBuffer.push(
              buildRange(
                node.from,
                node.to,
                Decoration.mark({class: nodeTypeClass(node.type.id)}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.to,
                node.to,
                Decoration.widget({
                  widget: new ImageWidget(linkPath, obsidianUtils.getImageUri),
                  block: true,
                }),
                tokenStartSide(node.type.id),
              )
            )
          } else {
            builderBuffer.push(
              buildRange(
                node.from,
                node.to,
                Decoration.replace({
                  widget: new ImageWidget(linkPath, obsidianUtils.getImageUri),
                }),
                tokenStartSide(node.type.id),
              )
            )
          }
        } else if (!nodeIsSelected) {
          if (node.type.id === TOKEN.RegularLink && linkPath !== displayText) {
            builderBuffer.push(
              buildRange(
                node.from,
                node.from+displayTextFromOffset,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.from+displayTextFromOffset,
                node.to-2,
                Decoration.mark({tagName: "a", attributes: { href: "#" }}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.to-2,
                node.to,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
          } else if (node.type.id === TOKEN.RegularLink) {
            builderBuffer.push(
              buildRange(
                node.from,
                node.from+2,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.from+2,
                node.to-2,
                Decoration.mark({tagName: "a", attributes: { href: "#" }}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.to-2,
                node.to,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
          } else if (node.type.id === TOKEN.AngleLink) {
            builderBuffer.push(
              buildRange(
                node.from,
                node.from+1,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.from+1,
                node.to-1,
                Decoration.mark({tagName: "a", attributes: { href: "#" }}),
                tokenStartSide(node.type.id),
              )
            )
            builderBuffer.push(
              buildRange(
                node.to-1,
                node.to,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
          } else if (node.type.id === TOKEN.PlainLink && settings.linkifyPlainUrls) {
            builderBuffer.push(
              buildRange(
                node.from,
                node.to,
                Decoration.mark({tagName: "a", attributes: { href: "#" }}),
                tokenStartSide(node.type.id),
              )
            )
          }
        } else {
          builderBuffer.push(
            buildRange(
              node.from,
              node.to,
              Decoration.mark({class: nodeTypeClass(node.type.id)}),
              tokenStartSide(node.type.id),
            )
          )
        }
      } else if (
        nodeIsOrgLang && (
          node.type.id === TOKEN.TextBold ||
          node.type.id === TOKEN.TextItalic ||
          node.type.id === TOKEN.TextUnderline ||
          node.type.id === TOKEN.TextVerbatim ||
          node.type.id === TOKEN.TextCode ||
          node.type.id === TOKEN.TextStrikeThrough
        )
      ) {
        if (!nodeIsSelected) {
          builderBuffer.push(
            buildRange(
              node.from,
              node.from+1,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        }
        builderBuffer.push(
          buildRange(
            node.from,
            node.to,
            Decoration.mark({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
        if (!nodeIsSelected) {
          builderBuffer.push(
            buildRange(
              node.to-1,
              node.to,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        }
      } else if (nodeIsOrgLang && node.type.id === TOKEN.Heading) {
        const headingLine = state.doc.lineAt(node.from)
        const headingLevel = headingLine.text.match(/^\*+/)[0].length
        const headingClass = nodeTypeClass(node.type.id)
        const starsPos = {from: headingLine.from, to: headingLine.from+headingLevel+1}
        const nodeStarsIsSelected = isNodeSelected(selectionPos, starsPos)
        // Line-level decoration for font-size
        builderBuffer.push(
          buildRange(
            headingLine.from,
            headingLine.from,
            Decoration.line({class: `${headingClass} ${headingClass}-${headingLevel}`}),
            tokenStartSide(node.type.id),
          )
        )
        if (settings.headingStyle === 'noStars' && !nodeStarsIsSelected) {
          builderBuffer.push(
            buildRange(
              headingLine.from,
              headingLine.from+headingLevel+1,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        } else if (settings.headingStyle === 'hashmarks' && !nodeStarsIsSelected) {
          builderBuffer.push(
            buildRange(
              headingLine.from,
              headingLine.from+headingLevel,
              Decoration.replace({
                widget: new (class extends WidgetType {
                  toDOM() {
                    const span = document.createElement("span")
                    span.textContent = "#".repeat(headingLevel)
                    return span
                  }
                }),
              }),
              tokenStartSide(node.type.id),
            )
          )
        } else if (settings.hideStars && !nodeStarsIsSelected) {
          // Legacy hideStars support
          builderBuffer.push(
            buildRange(
              headingLine.from,
              headingLine.from+headingLevel+1,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        }
        builderBuffer.push(
          buildRange(
            headingLine.from,
            headingLine.to,
            Decoration.mark({
              class: `${headingClass} ${headingClass}-${headingLevel}`
            }),
            tokenStartSide(node.type.id),
          )
        )
        // Note: We intentionally do NOT apply heading-level classes to section content
        // as that would make all body text inherit heading font-weight/size
      } else if (
        nodeIsOrgLang && (
          node.type.id === TOKEN.Title ||
          node.type.id === TOKEN.PlanningDeadline ||
          node.type.id === TOKEN.PlanningScheduled ||
          node.type.id === TOKEN.PlanningClosed ||
          node.type.id === TOKEN.PropertyDrawer ||
          node.type.id === TOKEN.ZerothSection ||
          node.type.id === TOKEN.Section ||
          node.type.id === TOKEN.CommentLine ||
          node.type.id === TOKEN.KeywordComment ||
          node.type.id === TOKEN.TodoKeyword ||
          node.type.id === TOKEN.Priority ||
          node.type.id === TOKEN.Tags
        )
      ) {
        builderBuffer.push(
          buildRange(
            node.from,
            node.to,
            Decoration.mark({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
      } else if (nodeIsOrgLang && node.type.id === TOKEN.HorizontalRule) {
        if (!nodeIsSelected) {
          let to = node.to
          // Don't include trailing newline in the replacement
          if (to > node.from && state.doc.sliceString(to-1, to) === '\n') {
            to = to - 1
          }
          builderBuffer.push(
            buildRange(
              node.from,
              to,
              Decoration.replace({
                widget: new HorizontalRuleWidget(),
              }),
              tokenStartSide(node.type.id),
            )
          )
        } else {
          builderBuffer.push(
            buildRange(
              node.from,
              node.from,
              Decoration.line({class: nodeTypeClass(node.type.id)}),
              tokenStartSide(node.type.id),
            )
          )
        }
      } else if (nodeIsOrgLang && node.type.id === TOKEN.ListItem) {
        const itemText = state.doc.sliceString(node.from, node.to)
        const line = state.doc.lineAt(node.from)
        // Detect bullet type and indentation depth
        const unorderedBulletMatch = itemText.match(/^(\s*)([-+]) /)
        const orderedBulletMatch = itemText.match(/^(\s*)(\d+)([.)]) /)
        const isUnordered = !!unorderedBulletMatch
        // Calculate nesting depth from leading whitespace (every 2 spaces = 1 level)
        const leadingSpaces = (unorderedBulletMatch || orderedBulletMatch)?.[1]?.length || 0
        const nestDepth = Math.floor(leadingSpaces / 2)
        // Replace unordered bullet with styled version
        if (isUnordered && !nodeIsSelected && settings.bulletStyle !== 'dash') {
          const bulletChars = BULLET_CHARS[settings.bulletStyle]
          const bulletChar = bulletChars[nestDepth % bulletChars.length]
          const bulletMarkerLen = unorderedBulletMatch[1].length + unorderedBulletMatch[2].length + 1 // indent + "- "
          if (bulletChar === '') {
            // 'none' style: hide bullet entirely
            builderBuffer.push(
              buildRange(
                node.from + unorderedBulletMatch[1].length,
                node.from + bulletMarkerLen,
                Decoration.replace({}),
                tokenStartSide(node.type.id),
              )
            )
          } else {
            builderBuffer.push(
              buildRange(
                node.from + unorderedBulletMatch[1].length,
                node.from + bulletMarkerLen,
                Decoration.replace({
                  widget: new BulletWidget(bulletChar),
                }),
                tokenStartSide(node.type.id),
              )
            )
          }
        }
        // Detect checkbox pattern: bullet + space + [ ] or [X] or [-]
        const checkboxMatch = itemText.match(/^(\s*(?:[-+]|\d+[.)])\s+)\[([ X\-])\]\s/)
        if (checkboxMatch && !nodeIsSelected) {
          const bulletLen = checkboxMatch[1].length
          const checkboxChar = checkboxMatch[2]
          // Replace the [X] / [ ] / [-] with a widget
          builderBuffer.push(
            buildRange(
              node.from + bulletLen,
              node.from + bulletLen + 3,
              Decoration.replace({
                widget: new CheckboxWidget(checkboxChar),
              }),
              tokenStartSide(node.type.id),
            )
          )
        }
        builderBuffer.push(
          buildRange(
            line.from,
            line.from,
            Decoration.line({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
        // Apply inline markup and links inside list items
        applyInlineMarkup(
          itemText,
          node.from,
          !nodeIsSelected,
          tokenStartSide(node.type.id),
          builderBuffer,
          settings.linkifyPlainUrls,
        )
      } else if (
        nodeIsOrgLang && (
          node.type.id === TOKEN.TableRow ||
          node.type.id === TOKEN.TableHrule
        )
      ) {
        // Collect this table node for grouped rendering
        // We track table groups and render them after the tree walk
        const line = state.doc.lineAt(node.from)
        if (!nodeIsSelected) {
          // Check if this is the first row of a contiguous table
          const prevLineNum = line.number - 1
          let isFirstTableLine = true
          if (prevLineNum >= 1) {
            const prevLine = state.doc.line(prevLineNum)
            if (prevLine.text.trim().startsWith('|')) {
              isFirstTableLine = false
            }
          }

          if (isFirstTableLine) {
            // Collect all consecutive table lines
            let endLineNum = line.number
            while (endLineNum < state.doc.lines) {
              const nextLine = state.doc.line(endLineNum + 1)
              if (!nextLine.text.trim().startsWith('|')) break
              endLineNum++
            }
            const tableFrom = line.from
            let tableTo = state.doc.line(endLineNum).to
            const tableText = state.doc.sliceString(tableFrom, tableTo)

            // Check if ANY line in the table is selected
            let tableIsSelected = false
            for (let i = line.number; i <= endLineNum; i++) {
              const tl = state.doc.line(i)
              if (isNodeSelected(selectionPos, tl)) {
                tableIsSelected = true
                break
              }
            }

            if (!tableIsSelected) {
              // Replace entire table with a widget
              // Handle trailing newline
              if (tableTo < state.doc.length && state.doc.sliceString(tableTo, tableTo + 1) === '\n') {
                // don't include trailing newline in replacement
              }
              builderBuffer.push(
                buildRange(
                  tableFrom,
                  tableTo,
                  Decoration.replace({
                    widget: new TableWidget(tableText, tableFrom),
                    block: true,
                  }),
                  tokenStartSide(node.type.id),
                )
              )
            } else {
              // Table is selected — show raw source with monospace styling
              for (let i = line.number; i <= endLineNum; i++) {
                const tl = state.doc.line(i)
                builderBuffer.push(
                  buildRange(
                    tl.from,
                    tl.from,
                    Decoration.line({class: "org-table-row"}),
                    tokenStartSide(node.type.id),
                  )
                )
              }
            }
          }
          // Non-first lines of the table are handled by the first-line branch above
        } else {
          // This specific line is selected — show raw monospace
          builderBuffer.push(
            buildRange(
              line.from,
              line.from,
              Decoration.line({class: "org-table-row"}),
              tokenStartSide(node.type.id),
            )
          )
        }
      } else if (nodeIsOrgLang && node.type.id === TOKEN.FixedWidthLine) {
        const line = state.doc.lineAt(node.from)
        builderBuffer.push(
          buildRange(
            line.from,
            line.from,
            Decoration.line({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
        if (!nodeIsSelected) {
          // Hide the ": " prefix
          builderBuffer.push(
            buildRange(
              node.from,
              node.from + 2,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
        }
      }
    },
  })
  return RangeSet.of(builderBuffer, true)
}

async function orgIdLinkCompletions(
  context: CompletionContext,
  obsidianUtils: {
    listOrgIds: () => Promise<string[][]>,
  },
): Promise<CompletionResult> {
  const word = context.matchBefore(/\[\[id:$/)
  if (!word) {
    return null
  }
  const orgIds = await obsidianUtils.listOrgIds()
  return {
    from: word.to,
    options: orgIds.map(([orgId, path]) => {
      return {
        label: orgId + "]]",
        displayLabel: "id:" + orgId,
        detail: path,
      };
    }),
    validFor: /[^\]]*/,
  };
}

function orgLinkCompletions(
  context: CompletionContext,
  obsidianUtils: {
    getVaultFiles: () => string[][],
    getLinkSuggestions?: () => Array<{ path?: string; alias?: string; file?: { path: string; basename: string; extension: string } }>,
  },
): CompletionResult {
  const word = context.matchBefore(/\[\[([^\]]*)$/)
  if (!word) return null
  const prefixEnd = word.from + 2
  const partial = word.text.slice(2)
  if (partial.startsWith("id:")) return null
  const suggestions = obsidianUtils.getLinkSuggestions?.()
  let options: Array<{ label: string; displayLabel: string; detail?: string; boost?: number }>
  if (suggestions && suggestions.length) {
    options = suggestions.map((s) => {
      const f = s.file
      const label = s.alias ?? (f ? (f.extension === "md" ? f.basename : f.path) : s.path || "")
      const displayLabel = s.alias ?? (f ? f.basename : s.path || "")
      const detail = s.alias && f ? f.path : (f ? (f.path !== f.basename ? f.path : undefined) : undefined)
      return {
        label: label + "]]",
        displayLabel,
        detail,
      }
    })
  } else {
    const vaultFiles = obsidianUtils.getVaultFiles()
    options = vaultFiles.map(([name, path]) => {
      let detail: string | undefined = undefined
      if (path !== name) detail = path.substring(0, path.lastIndexOf("/")) + "/"
      return {
        label: name + "]]",
        displayLabel: name,
        detail,
      }
    })
  }
  return {
    from: prefixEnd,
    options,
    validFor: /^[^\]]*$/,
  }
}

export const orgmodeLivePreview = (
  codeMirror: EditorView,
  settings: OrgmodePluginSettings,
  obsidianUtils: {
    navigateToFile: (filePath: string) => void,
    getImageUri: (linkPath: string) => string,
    navigateToOrgId: (orgCustomId: string) => void,
    getVaultFiles: () => string[][],
    getLinkSuggestions?: () => Array<{ path?: string; alias?: string; file?: { path: string; basename: string; extension: string } }>,
    listOrgIds: () => Promise<string[][]>,
    readFileContent: (filePath: string) => Promise<any>,
    triggerHoverLink?: (payload: { event: MouseEvent; linktext: string; targetEl: HTMLElement; sourcePath: string }) => void,
    getSourcePath?: () => string,
}) => {
  return StateField.define<DecorationSet>({
    create(state: EditorState): DecorationSet {
      return loadDecorations(state, settings, {...obsidianUtils})
    },
    update(oldState: DecorationSet, transaction: Transaction): DecorationSet {
      return loadDecorations(transaction.state, settings, {...obsidianUtils})
    },
    provide(field: StateField<DecorationSet>): Extension {
      return [
        EditorView.decorations.from(field),
        EditorView.domEventHandlers({
          mouseover: (e: MouseEvent) => {
            const target = e.target as HTMLElement
            if (!target || target.nodeType !== 1) return
            const anchor = target.closest("a") as HTMLAnchorElement | null
            if (!anchor) return
            const clickPos = codeMirror.posAtDOM(anchor)
            if (clickPos == null) return
            const state = codeMirror.state
            let linktext: string | null = null
            const decoSet = state.field(field)
            decoSet.between(clickPos, clickPos + 1, (from, to, deco) => {
              const plainUrl = deco.spec.attributes?.["data-plain-url"]
              if (plainUrl) { linktext = plainUrl; return false }
            })
            if (!linktext) {
              let nodeIterator = syntaxTree(state).resolveStack(clickPos)
              while (nodeIterator) {
                const nid = nodeIterator.node.type.id
                if (nid === TOKEN.RegularLink || nid === TOKEN.AngleLink || nid === TOKEN.PlainLink) {
                  const raw = state.doc.sliceString(nodeIterator.node.from, nodeIterator.node.to)
                  const [linkPath] = extractLinkFromNode(nid, raw)
                  if (linkPath) linktext = linkPath
                  break
                }
                nodeIterator = nodeIterator.next
              }
            }
            if (!linktext) return
            obsidianUtils.triggerHoverLink?.({
              event: e,
              linktext,
              targetEl: anchor,
              sourcePath: obsidianUtils.getSourcePath?.() ?? "",
            })
          },
          mousedown: (e: MouseEvent) => {
            const clickPos = codeMirror.posAtCoords(e)
            const state = codeMirror.state
            // First check for linkified plain URLs (synthetic anchors from applyInlineMarkup)
            const orgmodeDecorationSetEarly = state.field(field)
            let plainUrlHit: string | null = null
            orgmodeDecorationSetEarly.between(clickPos, clickPos, (from, to, deco) => {
              const url = deco.spec.attributes?.["data-plain-url"]
              if (url) {
                plainUrlHit = url
                return false
              }
            })
            if (plainUrlHit) {
              window.open(plainUrlHit)
              return
            }
            let nodeIterator = syntaxTree(state).resolveStack(clickPos)
            let linkNode = null
            while (nodeIterator) {
              if (
                nodeIterator.node.type.id === TOKEN.RegularLink ||
                nodeIterator.node.type.id === TOKEN.AngleLink ||
                nodeIterator.node.type.id === TOKEN.PlainLink
              ) {
                linkNode = nodeIterator.node
                break
              }
              nodeIterator = nodeIterator.next
            }
            if (!linkNode) {
              return
            }
            const linkText = state.doc.sliceString(linkNode.from, linkNode.to)
            const [linkPath, displayText, linkHandler, displayTextFromOffset] = extractLinkFromNode(linkNode.type.id, linkText)
            const orgmodeDecorationSet = state.field(field)
            orgmodeDecorationSet.between(clickPos, clickPos, (from, to, deco) => {
              if (deco.spec.tagName === "a") {
                if (linkHandler === "external") {
                  window.open(linkPath)
                } else if (linkHandler === "internal-file") {
                  obsidianUtils.navigateToFile(linkPath)
                } else if (linkHandler === "internal-id") {
                  const orgCustomId = linkPath
                  obsidianUtils.navigateToOrgId(orgCustomId)
                }
                return false
              }
            })
          }
        }),
        autocompletion({
          override: [
            (context: CompletionContext) => orgIdLinkCompletions(context, {...obsidianUtils}),
            (context: CompletionContext) => orgLinkCompletions(context, {...obsidianUtils}),
          ],
        }),
      ]
    },
  });
}
