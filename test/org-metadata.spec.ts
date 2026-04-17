import { expect, test } from 'vitest'
import { LRParser } from '@lezer/lr'

import { OrgmodeParser } from 'codemirror-lang-orgmode'
import { extractOrgMetadata, writeOrgFrontmatter } from 'org-metadata'

const parser: LRParser = OrgmodeParser(["TODO", "DONE"])

test("extracts top-level #+KEYWORD and drawer properties", () => {
  const content = [
    "#+TITLE: Example",
    "#+AUTHOR: Josh",
    "",
    ":PROPERTIES:",
    ":ID: abc-123",
    ":END:",
    "",
    "* A heading",
  ].join("\n")
  const meta = extractOrgMetadata(parser, content)
  expect(meta.frontmatter).toEqual({
    title: "Example",
    author: "Josh",
    id: "abc-123",
  })
})

test("extracts #+FILETAGS as tags array", () => {
  const content = "#+FILETAGS: :research:org:\n\n* Heading"
  const meta = extractOrgMetadata(parser, content)
  expect(meta.frontmatter?.tags).toEqual(["research", "org"])
})

test("extracts #+ALIASES as aliases array (space-separated)", () => {
  const content = "#+TITLE: Demo\n#+ALIASES: MyAlias AnotherName\n\n* Heading"
  const meta = extractOrgMetadata(parser, content)
  expect(meta.frontmatter?.aliases).toEqual(["MyAlias", "AnotherName"])
})

test("writeOrgFrontmatter: serializes aliases array back to space-separated #+ALIASES", () => {
  const content = "#+TITLE: Demo\n#+ALIASES: MyAlias AnotherName\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, {
    title: "Demo",
    aliases: ["MyAlias", "RenamedAlias"],
  })
  expect(out).toContain("#+ALIASES: MyAlias RenamedAlias")
})

test("writeOrgFrontmatter: updates an existing keyword in place", () => {
  const content = "#+TITLE: Old\n#+AUTHOR: Josh\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, {
    title: "New",
    author: "Josh",
  })
  expect(out).toBe("#+TITLE: New\n#+AUTHOR: Josh\n\n* Heading\n")
})

test("writeOrgFrontmatter: deletes a keyword not present in new frontmatter", () => {
  const content = "#+TITLE: Old\n#+AUTHOR: Josh\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, { title: "Old" })
  expect(out).toBe("#+TITLE: Old\n\n* Heading\n")
})

test("writeOrgFrontmatter: adds a new keyword after existing ones", () => {
  const content = "#+TITLE: Old\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, {
    title: "Old",
    status: "draft",
  })
  expect(out).toBe("#+TITLE: Old\n#+STATUS: draft\n\n* Heading\n")
})

test("writeOrgFrontmatter: inserts keywords at top when none exist", () => {
  const content = "* Heading\nBody\n"
  const out = writeOrgFrontmatter(parser, content, { title: "Hello" })
  expect(out).toBe("#+TITLE: Hello\n* Heading\nBody\n")
})

test("writeOrgFrontmatter: updates drawer property in place", () => {
  const content = [
    ":PROPERTIES:",
    ":ID: abc-123",
    ":CUSTOM_ID: foo",
    ":END:",
    "",
    "* Heading",
    "",
  ].join("\n")
  const out = writeOrgFrontmatter(parser, content, {
    id: "abc-123",
    custom_id: "bar",
  })
  expect(out).toContain(":CUSTOM_ID: bar")
  expect(out).toContain(":ID: abc-123")
})

test("writeOrgFrontmatter: tags array becomes #+FILETAGS with colon-form", () => {
  const content = "#+TITLE: Note\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, {
    title: "Note",
    tags: ["research", "org"],
  })
  expect(out).toContain("#+FILETAGS: :research:org:")
})

test("writeOrgFrontmatter: preserves case of existing keys", () => {
  const content = "#+Title: Old\n\n* Heading\n"
  const out = writeOrgFrontmatter(parser, content, { title: "New" })
  expect(out).toBe("#+Title: New\n\n* Heading\n")
})

test("writeOrgFrontmatter: full round-trip preserves mixed keyword/drawer form", () => {
  const content = [
    "#+TITLE: Test",
    "#+AUTHOR: Josh",
    "",
    ":PROPERTIES:",
    ":ID: abc",
    ":CUSTOM_ID: custom",
    ":END:",
    "",
    "* Heading",
    "",
  ].join("\n")
  const meta = extractOrgMetadata(parser, content)
  const out = writeOrgFrontmatter(parser, content, meta.frontmatter!)
  // No-op when the frontmatter object equals what was extracted.
  expect(out).toBe(content)
})

test("writeOrgFrontmatter: changing a keyword does not touch drawer entries", () => {
  const content = [
    "#+TITLE: Test",
    "",
    ":PROPERTIES:",
    ":ID: abc",
    ":END:",
    "",
    "* Heading",
    "",
  ].join("\n")
  const out = writeOrgFrontmatter(parser, content, { title: "Updated", id: "abc" })
  expect(out).toBe([
    "#+TITLE: Updated",
    "",
    ":PROPERTIES:",
    ":ID: abc",
    ":END:",
    "",
    "* Heading",
    "",
  ].join("\n"))
})
