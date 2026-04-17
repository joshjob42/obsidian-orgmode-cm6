import { foldService, syntaxTree, foldCode, unfoldCode } from "@codemirror/language"
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SyntaxNode } from "@lezer/common"
import { LRParser } from "@lezer/lr";

import { TOKEN } from 'codemirror-lang-orgmode';

export function nodeTypeClass(node_type_id: number): string {
  if (node_type_id === TOKEN.TextBold) {
    return "org-text-bold"
  } else if (node_type_id === TOKEN.TextItalic) {
    return "org-text-italic"
  } else if (node_type_id === TOKEN.TextUnderline) {
    return "org-text-underline"
  } else if (node_type_id === TOKEN.TextVerbatim) {
    return "org-text-verbatim"
  } else if (node_type_id === TOKEN.TextCode) {
    return "org-text-code"
  } else if (node_type_id === TOKEN.TextStrikeThrough) {
    return "org-text-strikethrough"
  } else if (node_type_id === TOKEN.Block) {
    return "org-block"
  } else if (
    node_type_id === TOKEN.RegularLink ||
    node_type_id === TOKEN.AngleLink ||
    node_type_id === TOKEN.PlainLink
  ) {
    return "org-link"
  } else if (node_type_id === TOKEN.Heading) {
    return "org-heading"
  } else if (node_type_id === TOKEN.Title) {
    return "org-title"
  } else if (
    node_type_id === TOKEN.PlanningDeadline ||
    node_type_id === TOKEN.PlanningScheduled ||
    node_type_id === TOKEN.PlanningClosed
  ) {
    return "org-planning"
  } else if (node_type_id === TOKEN.PropertyDrawer) {
    return "org-propertydrawer"
  } else if (
    node_type_id === TOKEN.ZerothSection ||
    node_type_id === TOKEN.Section
  ) {
    return "org-section"
  } else if (
    node_type_id === TOKEN.CommentLine ||
    node_type_id === TOKEN.KeywordComment
  ) {
    return "org-comment"
  } else if (node_type_id === TOKEN.TodoKeyword) {
    return "org-keyword"
  } else if (node_type_id === TOKEN.Priority) {
    return "org-priority"
  } else if (node_type_id === TOKEN.Tags) {
    return "org-tags"
  } else if (node_type_id === TOKEN.HorizontalRule) {
    return "org-horizontal-rule"
  } else if (node_type_id === TOKEN.FixedWidthLine) {
    return "org-fixed-width"
  } else if (node_type_id === TOKEN.ListItem) {
    return "org-list-item"
  } else if (node_type_id === TOKEN.TableRow) {
    return "org-table-row"
  } else if (node_type_id === TOKEN.TableHrule) {
    return "org-table-hrule"
  }
  throw Error("Not a markup node")
}

export const OrgFoldCompute = (state: EditorState, from: number, to: number) => {
  let currentLineNode = syntaxTree(state).topNode.resolve(from, 1).node
  const onFirstLine = (state.doc.lineAt(from).number === state.doc.lineAt(currentLineNode.from).number)
  if (currentLineNode.type.id === TOKEN.Heading) {
    const heading = currentLineNode
    const hasSection = currentLineNode.getChild(TOKEN.Section)
    const hasHeading = currentLineNode.getChild(TOKEN.Heading)
    if (!hasSection && !hasHeading) {
      return null
    }
    let block_to = heading.to
    if (state.doc.sliceString(block_to-1, block_to) === '\n') {
      block_to = block_to - 1
    }
    return { from: to, to: block_to };
  } else if (currentLineNode.type.id === TOKEN.PropertyDrawer) {
    if (!onFirstLine) {
      return null
    }
    const propertyDrawer = currentLineNode
    let block_to = propertyDrawer.to
    if (state.doc.sliceString(block_to-1, block_to) === '\n') {
      block_to = block_to - 1
    }
    return { from: to, to: block_to };
  } else if (currentLineNode.type.id === TOKEN.Block) {
    if (!onFirstLine) {
      return null
    }
    const blockNode = currentLineNode
    let block_to = blockNode.to
    if (state.doc.sliceString(block_to-1, block_to) === '\n') {
      block_to = block_to - 1
    }
    return { from: to, to: block_to };
  } else if (currentLineNode.type.id === TOKEN.ListItem) {
    if (!onFirstLine) {
      return null
    }
    const listItem = currentLineNode
    // Only fold if the list item spans multiple lines
    const firstLine = state.doc.lineAt(listItem.from)
    let item_to = listItem.to
    if (state.doc.sliceString(item_to-1, item_to) === '\n') {
      item_to = item_to - 1
    }
    if (item_to <= firstLine.to) {
      return null  // single-line item, nothing to fold
    }
    return { from: firstLine.to, to: item_to };
  }
  return null
}

export const makeHeadingsFoldable = foldService.of(OrgFoldCompute);

function linkIsImage(linkText: string) {
  if (!linkText.includes(".")) {
    return false
  }
  const ext = linkText.slice(linkText.lastIndexOf("."))
  const imageExtensions = ['.apng', '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']
  return imageExtensions.includes(ext)
}

export type LinkHandler = "external" | "internal-file" | "internal-inline-image" | "internal-id"

function parseLinkText(linkText: string): [string, LinkHandler] {
  const idx = linkText.indexOf(':')
  let linkPath = null
  let linkHandler: LinkHandler = null
  let linkType = null
  if (idx === -1) {  // case 'PATHINNER'
    linkHandler = "internal-file"
    linkPath = linkText
  } else if (/:\/\//.test(linkText)) {  // case 'LINKTYPE://PATHINNER'
    linkPath = linkText
    linkHandler = "external"
  } else {  // case 'LINKTYPE:PATHINNER'
    linkType = linkText.slice(0, idx)
    linkPath = linkText.slice(idx+1)
    if (linkType === 'file') {
      linkHandler = "internal-file"
    } else if (linkType === 'id') {
      linkHandler = "internal-id"
    } else {
      // not handled
      linkHandler = "internal-file"
    }
  }
  return [linkPath, linkHandler]
}

export const extractLinkFromNode = (node: number, linkText: string): [string, string, LinkHandler, number] => {
  let linkHandler: LinkHandler = null
  let linkPath = null
  let displayText = null
  let hasLinkDescription = false
  let displayTextFromOffset = null
  let displayTextToOffset = null
  if (node === TOKEN.PlainLink) {
    linkPath = linkText
    displayTextFromOffset = 0
    displayTextToOffset = 0
    linkHandler = "external"
    let [linkPathDetected, linkHandlerDetected] = parseLinkText(linkText)
    if (linkHandlerDetected == "internal-id") {
      linkHandler = "internal-id"
      linkPath = linkPathDetected
    }
  } else if (node === TOKEN.RegularLink) {
    let innerLinkText
    if (/\]\[/.test(linkText)) {
      const idx = linkText.search(/\]\[/)
      innerLinkText = linkText.slice(2, idx)
      displayTextFromOffset = idx + 2
      displayTextToOffset = -2
      hasLinkDescription = true
    } else {
      innerLinkText = linkText.slice(2, -2)
      displayTextFromOffset = 2
      displayTextToOffset = -2
    }
    [linkPath, linkHandler] = parseLinkText(innerLinkText)
  } else if (node === TOKEN.AngleLink) {
    [linkPath, linkHandler] = parseLinkText(linkText.slice(1, -1))
    displayTextFromOffset = 1
    displayTextToOffset = -1
  }
  if (linkHandler === "internal-file" && linkIsImage(linkPath) && !hasLinkDescription) {
    linkHandler = "internal-inline-image"
    displayTextFromOffset = null
    displayTextToOffset = null
  }
  if (displayTextFromOffset !== null) {
    displayText = linkText.slice(displayTextFromOffset, linkText.length+displayTextToOffset)
  }
  return [linkPath, displayText, linkHandler, displayTextFromOffset]
}

function* iterateHeadings(node: SyntaxNode): Iterable<SyntaxNode> {
  const headings = node.getChildren(TOKEN.Heading)
  for (const heading of headings) {
    yield heading
    yield* iterateHeadings(heading)
  }
}

export function* iterateOrgIds(orgmodeParser: LRParser, orgContent: string) {
  const tree = orgmodeParser.parse(orgContent)
  const id_regex = /:ID:\s+([^\s]+)\s*/  // TODO: to replace by a grammar token?
  const topPropertyDrawer = tree.topNode.getChild(TOKEN.ZerothSection)?.getChild(TOKEN.PropertyDrawer)
  if (topPropertyDrawer) {
    const top_pd_content = orgContent.slice(topPropertyDrawer.from, topPropertyDrawer.to)
    const match_file = id_regex.exec(top_pd_content)
    if (match_file) {
      const extracted_id = match_file[1]
      yield {orgId: extracted_id, start: 0}
    }
  }
  for (const heading of iterateHeadings(tree.topNode)) {
    const propertyDrawer = heading.node.getChild(TOKEN.Section)?.getChild(TOKEN.PropertyDrawer)
    if (!propertyDrawer) {
      continue
    }
    const heading_start = heading.from
    const pd_content = orgContent.slice(propertyDrawer.from, propertyDrawer.to)
    const match_heading = id_regex.exec(pd_content)
    if (match_heading) {
      const extracted_id = match_heading[1]
      yield {orgId: extracted_id, start: heading_start}
    }
  }
}

function isNumeric(s: string): boolean {
  const trimmed = s.trim()
  if (trimmed === '') return false
  return /^-?\d+(\.\d+)?$/.test(trimmed)
}

function parseCells(line: string): string[] | null {
  if (!line.startsWith('|')) return null
  // Split by |, drop first empty element (before first |)
  const parts = line.split('|')
  if (parts.length < 3) return null  // need at least | cell |
  // Remove first and last (empty from leading/trailing |)
  return parts.slice(1, parts.length - 1)
}

function isHruleLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  return /^\|[-+| ]+\|?\s*$/.test(trimmed)
}

export function alignTable(view: EditorView): boolean {
  const state = view.state
  const cursorPos = state.selection.main.head
  const cursorLine = state.doc.lineAt(cursorPos)

  // Check if cursor is on a table line
  const cursorLineText = cursorLine.text.trim()
  if (!cursorLineText.startsWith('|')) return false

  // Find the extent of the table (contiguous lines starting with |)
  let startLine = cursorLine.number
  let endLine = cursorLine.number
  while (startLine > 1) {
    const prevLine = state.doc.line(startLine - 1)
    if (!prevLine.text.trim().startsWith('|')) break
    startLine--
  }
  while (endLine < state.doc.lines) {
    const nextLine = state.doc.line(endLine + 1)
    if (!nextLine.text.trim().startsWith('|')) break
    endLine++
  }

  // Parse all rows to find max column widths
  const rows: { cells: string[], isHrule: boolean, lineNum: number }[] = []
  let maxCols = 0
  for (let i = startLine; i <= endLine; i++) {
    const line = state.doc.line(i)
    const text = line.text
    const hrule = isHruleLine(text)
    if (hrule) {
      rows.push({ cells: [], isHrule: true, lineNum: i })
    } else {
      const cells = parseCells(text)
      if (cells) {
        rows.push({ cells, isHrule: false, lineNum: i })
        maxCols = Math.max(maxCols, cells.length)
      }
    }
  }

  if (maxCols === 0) return false

  // Calculate column widths and detect numeric columns
  const colWidths: number[] = new Array(maxCols).fill(1)
  const colNumeric: boolean[] = new Array(maxCols).fill(true)

  for (const row of rows) {
    if (row.isHrule) continue
    for (let c = 0; c < row.cells.length; c++) {
      const cellContent = row.cells[c].trim()
      colWidths[c] = Math.max(colWidths[c], cellContent.length)
      if (cellContent !== '' && !isNumeric(cellContent)) {
        colNumeric[c] = false
      }
    }
  }

  // Build aligned table
  const newLines: string[] = []
  for (const row of rows) {
    if (row.isHrule) {
      const parts = colWidths.map(w => '-'.repeat(w + 2))
      newLines.push('|' + parts.join('+') + '|')
    } else {
      const parts: string[] = []
      for (let c = 0; c < maxCols; c++) {
        const cellContent = (c < row.cells.length ? row.cells[c] : '').trim()
        if (colNumeric[c]) {
          // Right-align numbers
          parts.push(' ' + cellContent.padStart(colWidths[c]) + ' ')
        } else {
          // Left-align text
          parts.push(' ' + cellContent.padEnd(colWidths[c]) + ' ')
        }
      }
      newLines.push('|' + parts.join('|') + '|')
    }
  }

  const newText = newLines.join('\n')
  const from = state.doc.line(startLine).from
  const to = state.doc.line(endLine).to

  // Only update if something changed
  const oldText = state.doc.sliceString(from, to)
  if (oldText === newText) return false

  view.dispatch({
    changes: { from, to, insert: newText },
    selection: { anchor: Math.min(cursorPos, from + newText.length) }
  })
  return true
}

export function listIndent(view: EditorView): boolean {
  const state = view.state
  const cursorPos = state.selection.main.head
  const line = state.doc.lineAt(cursorPos)
  const lineText = line.text
  const orderedMatch = lineText.match(/^(\s*)(\d+)([.)]) /)
  if (!lineText.match(/^\s*(?:[-+]|\d+[.)])\s/)) return false
  if (orderedMatch) {
    // Reset number to 1 when indenting (new sub-list)
    const indent = orderedMatch[1]
    const sep = orderedMatch[3]
    const oldPrefix = orderedMatch[0]
    const newPrefix = indent + "  1" + sep + " "
    const cursorOffset = newPrefix.length - oldPrefix.length
    view.dispatch({
      changes: { from: line.from, to: line.from + oldPrefix.length, insert: newPrefix },
      selection: { anchor: cursorPos + cursorOffset },
    })
  } else {
    // Unordered: just add 2 spaces
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: "  " },
      selection: { anchor: cursorPos + 2 },
    })
  }
  return true
}

export function listDedent(view: EditorView): boolean {
  const state = view.state
  const cursorPos = state.selection.main.head
  const line = state.doc.lineAt(cursorPos)
  const lineText = line.text
  if (!lineText.match(/^\s*(?:[-+]|\d+[.)])\s/)) return false
  // Remove up to 2 spaces of leading indentation
  let removeCount = 0
  if (lineText.startsWith("  ")) removeCount = 2
  else if (lineText.startsWith(" ")) removeCount = 1
  if (removeCount === 0) return false
  view.dispatch({
    changes: { from: line.from, to: line.from + removeCount },
    selection: { anchor: Math.max(line.from, cursorPos - removeCount) },
  })
  return true
}

export function listContinueLine(view: EditorView): boolean {
  const state = view.state
  const cursorPos = state.selection.main.head
  const line = state.doc.lineAt(cursorPos)

  // Search current line and upward to find the bullet line
  let contentIndent = 0
  let found = false
  for (let lineNum = line.number; lineNum >= 1; lineNum--) {
    const searchLine = state.doc.line(lineNum)
    const searchText = searchLine.text
    const unorderedMatch = searchText.match(/^(\s*)([-+]) /)
    const orderedMatch = searchText.match(/^(\s*)(\d+)([.)]) /)
    if (unorderedMatch) {
      contentIndent = unorderedMatch[1].length + unorderedMatch[2].length + 1
      found = true
      break
    } else if (orderedMatch) {
      contentIndent = orderedMatch[1].length + orderedMatch[2].length + orderedMatch[3].length + 1
      found = true
      break
    } else if (searchText.trim() === '' || !searchText.match(/^\s/)) {
      // Blank line or non-indented line = not in a list item
      break
    }
  }

  if (!found) return false

  const padding = " ".repeat(contentIndent)
  view.dispatch({
    changes: { from: cursorPos, to: cursorPos, insert: "\n" + padding },
    selection: { anchor: cursorPos + 1 + contentIndent },
  })
  return true
}

export function toggleFoldAtCursor(view: EditorView): boolean {
  // Try to unfold first; if nothing to unfold, try to fold
  if (unfoldCode(view)) return true
  if (foldCode(view)) return true
  return false
}

export function listAutoIndent(view: EditorView): boolean {
  const state = view.state
  const cursorPos = state.selection.main.head
  const line = state.doc.lineAt(cursorPos)
  const lineText = line.text

  // Check if current line is a list item
  const unorderedMatch = lineText.match(/^(\s*)([-+])\s/)
  const orderedMatch = lineText.match(/^(\s*)(\d+)([.)]) /)
  const checkboxMatch = lineText.match(/^(\s*)([-+])\s+\[[ X\-]\]\s/)

  if (!unorderedMatch && !orderedMatch) {
    return false  // not in a list item
  }

  if (unorderedMatch) {
    const indent = unorderedMatch[1]
    const bullet = unorderedMatch[2]
    // If line is empty list item (just bullet), remove it
    if (lineText.trim() === bullet || lineText.trim() === `${bullet} [ ]` || lineText.trim() === `${bullet} [X]` || lineText.trim() === `${bullet} [-]`) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
      })
      return true
    }
    const newBullet = checkboxMatch ? `${indent}${bullet} [ ] ` : `${indent}${bullet} `
    view.dispatch({
      changes: { from: cursorPos, to: cursorPos, insert: "\n" + newBullet },
      selection: { anchor: cursorPos + 1 + newBullet.length },
    })
    return true
  }

  if (orderedMatch) {
    const indent = orderedMatch[1]
    const num = parseInt(orderedMatch[2])
    const sep = orderedMatch[3]
    // If line is empty ordered item (just number), remove it
    if (lineText.trim() === `${num}${sep}`) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
      })
      return true
    }
    const newBullet = `${indent}${num + 1}${sep} `
    view.dispatch({
      changes: { from: cursorPos, to: cursorPos, insert: "\n" + newBullet },
      selection: { anchor: cursorPos + 1 + newBullet.length },
    })
    return true
  }

  return false
}