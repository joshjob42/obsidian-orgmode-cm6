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
import { OrgmodePluginSettings } from "settings";
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
    input.disabled = true
    return input
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
        if (settings.hideStars && !nodeStarsIsSelected) {
          builderBuffer.push(
            buildRange(
              headingLine.from,
              headingLine.from+headingLevel+1,
              Decoration.replace({}),
              tokenStartSide(node.type.id),
            )
          )
          builderBuffer.push(
            buildRange(
              headingLine.from,
              headingLine.to,
              Decoration.mark({class: `${headingClass} ${headingClass}-${headingLevel}`}),
              tokenStartSide(node.type.id),
            )
          )
        } else {
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
        }
        const section = node.node.getChild(TOKEN.Section)
        if (section) {
          builderBuffer.push(
            buildRange(
              section.from,
              section.to,
              Decoration.mark({class: `${headingClass}-${headingLevel}`}),
              tokenStartSide(node.type.id),
            )
          )
        }
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
      } else if (nodeIsOrgLang && node.type.id === TOKEN.TableHrule) {
        const line = state.doc.lineAt(node.from)
        builderBuffer.push(
          buildRange(
            line.from,
            line.from,
            Decoration.line({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
      } else if (nodeIsOrgLang && node.type.id === TOKEN.TableRow) {
        const line = state.doc.lineAt(node.from)
        builderBuffer.push(
          buildRange(
            line.from,
            line.from,
            Decoration.line({class: nodeTypeClass(node.type.id)}),
            tokenStartSide(node.type.id),
          )
        )
        // Apply text formatting inside table cells
        const rowText = state.doc.sliceString(node.from, node.to)
        const markupPatterns: [RegExp, string][] = [
          [/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "org-text-bold"],
          [/\/([^\s/](?:[^/]*[^\s/])?)\/(?=[^a-zA-Z0-9]|$)/g, "org-text-italic"],
          [/_([^\s_](?:[^_]*[^\s_])?)_/g, "org-text-underline"],
          [/\+([^\s+](?:[^+]*[^\s+])?)\+/g, "org-text-strikethrough"],
          [/=([^\s=](?:[^=]*[^\s=])?)=/g, "org-text-verbatim"],
          [/~([^\s~](?:[^~]*[^\s~])?)~/g, "org-text-code"],
        ]
        for (const [pattern, cssClass] of markupPatterns) {
          let match: RegExpExecArray | null
          pattern.lastIndex = 0
          while ((match = pattern.exec(rowText)) !== null) {
            const matchStart = node.from + match.index
            const matchEnd = matchStart + match[0].length
            if (!nodeIsSelected) {
              // Hide opening marker
              builderBuffer.push(
                buildRange(
                  matchStart,
                  matchStart + 1,
                  Decoration.replace({}),
                  tokenStartSide(node.type.id),
                )
              )
              // Hide closing marker
              builderBuffer.push(
                buildRange(
                  matchEnd - 1,
                  matchEnd,
                  Decoration.replace({}),
                  tokenStartSide(node.type.id),
                )
              )
            }
            builderBuffer.push(
              buildRange(
                matchStart,
                matchEnd,
                Decoration.mark({class: cssClass}),
                tokenStartSide(node.type.id),
              )
            )
          }
        }
        // Detect links inside table cells: [[url][desc]] or [[url]]
        const linkPattern = /\[\[([^\]]+?)(?:\]\[([^\]]+?))?\]\]/g
        let linkMatch: RegExpExecArray | null
        while ((linkMatch = linkPattern.exec(rowText)) !== null) {
          const matchStart = node.from + linkMatch.index
          const matchEnd = matchStart + linkMatch[0].length
          if (!nodeIsSelected) {
            if (linkMatch[2]) {
              // Has description: hide [[url][ and ]]
              const descStart = matchStart + linkMatch[0].indexOf('][') + 2
              builderBuffer.push(
                buildRange(matchStart, descStart, Decoration.replace({}), tokenStartSide(node.type.id))
              )
              builderBuffer.push(
                buildRange(descStart, matchEnd - 2, Decoration.mark({tagName: "a", attributes: { href: "#" }}), tokenStartSide(node.type.id))
              )
              builderBuffer.push(
                buildRange(matchEnd - 2, matchEnd, Decoration.replace({}), tokenStartSide(node.type.id))
              )
            } else {
              // No description: hide [[ and ]]
              builderBuffer.push(
                buildRange(matchStart, matchStart + 2, Decoration.replace({}), tokenStartSide(node.type.id))
              )
              builderBuffer.push(
                buildRange(matchStart + 2, matchEnd - 2, Decoration.mark({tagName: "a", attributes: { href: "#" }}), tokenStartSide(node.type.id))
              )
              builderBuffer.push(
                buildRange(matchEnd - 2, matchEnd, Decoration.replace({}), tokenStartSide(node.type.id))
              )
            }
          } else {
            builderBuffer.push(
              buildRange(matchStart, matchEnd, Decoration.mark({class: "org-link"}), tokenStartSide(node.type.id))
            )
          }
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
  },
): CompletionResult {
  const word = context.matchBefore(/\[\[$/)
  if (!word) {
    return null
  }
  const vaultFiles = obsidianUtils.getVaultFiles()
  return {
    from: word.to,
    options: vaultFiles.map(([name, path]) => {
      if (path === name) {
        path = null;
      } else {
        path = path.substring(0, path.lastIndexOf("/")) + "/";
      }
      return {
        label: name + "]]",
        displayLabel: name,
        detail: path,
      };
    }),
    validFor: /[^\]]*/,
  };
}

export const orgmodeLivePreview = (
  codeMirror: EditorView,
  settings: OrgmodePluginSettings,
  obsidianUtils: {
    navigateToFile: (filePath: string) => void,
    getImageUri: (linkPath: string) => string,
    navigateToOrgId: (orgCustomId: string) => void,
    getVaultFiles: () => string[][],
    listOrgIds: () => Promise<string[][]>,
    readFileContent: (filePath: string) => Promise<any>
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
          mousedown: (e: MouseEvent) => {
            const clickPos = codeMirror.posAtCoords(e)
            const state = codeMirror.state
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
