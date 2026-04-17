# Obsidian Orgmode CM6

[Orgmode](https://orgmode.org) for [Obsidian](https://obsidian.md).

![Screenshot](./screenshot.png)

> **This is a fork** of [BBazard/obsidian-orgmode-cm6](https://github.com/BBazard/obsidian-orgmode-cm6) that extends the plugin so org-mode files feel native in Obsidian — matching live-preview rendering, inline properties UI, and first-class integration with Obsidian's search, graph, and transclusion features. See [Fork additions](#fork-additions) below for the full list.

## Usage

By default org files are not shown in the sidebar.
To display them you need to go into the obsidian settings, section `Files and links` and check `Detect all file extensions`.

![detect-all-file-extensions](https://github.com/BBazard/obsidian-orgmode-cm6/assets/10139245/e6a91e66-295d-4057-bf80-e43dcdb8e3e7)

To create an org file in your vault, you currently have to create it outside obsidian, as obsidian doesn't allow to create a non-markdown file.

If you don't already have an org file, try to create a file called `todo.org` with the following content:

```org
* TODO [#A] A task with *high* priority

The description of the task

* A collapsed section

You cannot see the description when collapsed

* DONE something done already :sometag:
SCHEDULED: <2023-12-08 Fri 11:13>
:PROPERTIES:
:CREATED: [2023-12-03 Sun 10:48]
:END:

a [[https://github.com/BBazard/obsidian-orgmode-cm6][link]]

#+begin_src javascript
const block = "highlighted"
#+end_src
```

## Fork additions

The list below summarizes the features added by this fork on top of upstream `2.11.0`. Each item links to the PR that introduced it.

### Rendering

- **OD1 base features** ([#1](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/1)) — live-preview rendering for horizontal rules, fixed-width / example lines, list items with checkboxes, and tables with row / hrule parsing.
- **Table cell formatting & alignment command** ([#2](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/2)) — inline markup and links render inside table cells; a `Tab` keybinding aligns table columns by padding to symmetric widths.
- **Rendering quality fixes** ([#3](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/3)) — heading sizes match Obsidian markdown h1–h6; strikethrough renders for `~struck~`; table widgets render as proper widgets; body text weight matches Obsidian defaults; inline markup and links work inside list items and `QUOTE` / `VERSE` blocks.
- **Clickable table widgets** ([#4](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/4)) — clicking a rendered table cell places the cursor in that cell rather than jumping to the start of the table.
- **Multi-line list items** ([#5](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/5)) — list items can span multiple lines with continuation detection, fold at list-item boundaries, auto-indent on newline, and Tab / Shift-Tab to change indent.

### Obsidian integration

- **Inline metadata** ([#6](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/6)) — org keyword lines (`#+TITLE:`, `#+FILETAGS:`, `#+AUTHOR:`, …) and `:PROPERTIES:` drawers are extracted and written into Obsidian's `metadataCache` as if they were YAML frontmatter. An inline "properties tray" renders Obsidian's native `MetadataEditor` below the first heading of any `.org` file so properties can be viewed / edited with the same UI as markdown files. Edits write back to the org source.
- **Obsidian parity layer** ([#7](https://github.com/joshjob42/obsidian-orgmode-cm6/pull/7))
  - **Shadow-md index** — a companion directory of generated `.md` files mirrors each `.org` file's content so Obsidian's full-text search and graph view surface org content. Clicking a shadow opens the real `.org` file. Configurable folder (default `_o/`) and on/off toggle in settings. A "Rebuild shadow index" command is available from the palette.
  - **Org embed renderer** — `![[file.org]]` transclusions are rendered inline (replacing Obsidian's default "file not indexed" placeholder) with live-preview content from the target org file.

### Settings added by the fork

- **Heading display style** — `stars` (default, shows `* **`), `noStars` (hide), or `hashmarks` (show as `#`).
- **List bullet style** — `unicode` (default, `• ◦ ▪ ▹`), `dash`, or `none`.
- **Linkify plain URLs** — toggle making bare URLs clickable like Obsidian markdown. Off by default to preserve org-mode semantics (bare URLs are plain text).
- **Shadow markdown index** — on/off.
- **Shadow index folder** — folder path, default `_o`.

## Supported features (cumulative)

### Orgmode Editor

- Live Preview
- Syntax highlighting (with overridable css classes)
- Customizable Todo Keywords in settings
- Folding (click in the gutter on the first line of the element to fold it)
- Wiki links (`[[unicorn]]` will open the file unicorn.org anywhere in the vault or fallback to unicorn.md)
- Inline images (`[[myimage.png]]` will display the image if it exists in the vault)
- ID links (`[[id:12345]]` will redirect to the heading with the matching :ID: in a property drawer located in any org file in the vault)
- Vim support (if activated in Obsidian)
- Source blocks highlighting (supported: c, c++, css, html, java, javascript, json, php, python, rust, sass, xml)
- **(fork)** Inline properties tray — native Obsidian property editor below each org heading
- **(fork)** Shadow-md index — org content indexed for Obsidian's full-text search & graph
- **(fork)** `![[file.org]]` embed rendering

### Orgmode Parser (syntax highlighting)

Following [Org Syntax](https://orgmode.org/worg/org-syntax.html)

- [x] Heading (nested, no support for COMMENT heading)
- [x] Section (including zeroth section)
- [x] Text markup (bold, italic, underline, etc...)
- [x] Link (regular link, angle link, plain link)
- [x] Combination of markup and link
- [x] Comment line
- [x] Keyword line
- [x] Planning line
- [x] Property Drawer
- [x] Lesser Block (unformatted except source blocks)
- [x] Dynamic Block (see the dedicated section further down this readme)
- [x] **List and Checkbox** *(fork)*
- [x] **Horizontal rule** *(fork)*
- [x] **Table** *(fork — row and hrule parsing, inline markup inside cells, alignment command)*
- [x] **Fixed-width line** *(fork)*
- [ ] Drawer
- [ ] Timestamp
- [ ] Clock
- [ ] Diary Sexp
- [ ] Footnote
- [ ] Latex

## Implementation details

- The orgmode files are handled with a [codemirror 6](https://codemirror.net) instance which is separate from the one used by the markdown files. That means the plugin has to re-implement all features working for markdown files.

- The parser reads an orgmode file and builds a tree of syntax nodes by using a [lezer](https://lezer.codemirror.net) grammar with custom tokenizers. This approach allows to match tokens more precisely than the regex-based approach of Emacs. For example, planning lines are only matched after a heading and not in the middle of a section.

- Overlapping tokens are not considered valid. Take for example: `*one _two three* four_`. Emacs, using regexes would have `*one _two three*` as bold and `_two three* four_` as underline. The lezer parser is instead considering `*one _two three*` as bold and ` four_` as normal text, it makes it possible to have the text markup range as its own syntax node.

- There is no limits to the level of headings (so no Inlinetask) or the number of lines of a text markup.

- **(fork) Metadata bridge.** Obsidian's `metadataCache` keys file metadata by a content hash under `fileCache[path] = { mtime, size, hash }` with `metadataCache[hash] = CachedMetadata`. The fork extracts `CachedMetadata`-shaped objects (`frontmatter`, `tags`, `links`, `headings`, `sections`, `blocks`) from a parsed org tree and writes them into those two tables, so Obsidian's backlinks, tag pane, properties view, and search all see org content without any changes to Obsidian itself.

- **(fork) Shadow-md index.** A `StateField`-free background watcher mirrors every `.org` file into a corresponding `.md` under a configurable folder (default `_o/`). The shadow file contains the raw org text with frontmatter that carries the source path. Obsidian's full-text search and graph indexer consume the shadows; clicking a shadow hit re-routes to the real `.org` file.

## Dynamic Blocks

Dynamic blocks call a user-defined function and show the function output.

Only javascript functions without parameters are supported currently.

Example of displaying the date with a dynamic block in an orgmode file:

```org
#+BEGIN: getDate
#+END:
```

The function needs to be defined in the javascript definition file:

```javascript
function getDate() {
  return new Date().toISOString()
}
```

The javascript definition file is a file in your vault that contains the functions you can call from dynamic blocks. Its filepath must be specified in the plugin settings.

The content of your orgmode files are never modified by the execution of dynamic blocks.

## Show orgmode tasks in markdown files

This feature is unstable and will likely change in breaking ways in the future.

Currently only TODO and DONE are handled.

https://github.com/BBazard/obsidian-orgmode-cm6/assets/10139245/b071b2c8-b56e-4050-8fcf-02a922fdd1c0

To filter, [orgzly search expression](https://www.orgzly.com/docs#search) are supported (implemented: s, d, c, i, it).

```orgmode-tasks
filepath: Orgmode/Orgmode file.org
query: it.todo or it.done
```

## Development

```
git clone https://github.com/joshjob42/obsidian-orgmode-cm6
cd obsidian-orgmode-cm6
npm install
npm run build
npm test
cp main.js styles.css manifest.json "$OBSIDIAN_VAULT"/.obsidian/plugins/orgmode-cm6/
```

## Credits & upstream

This fork is built on top of [BBazard/obsidian-orgmode-cm6](https://github.com/BBazard/obsidian-orgmode-cm6). The core parser, live-preview architecture, dynamic blocks, and orgmode-tasks features are all upstream work.
