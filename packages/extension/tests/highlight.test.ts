import { describe, it, expect } from "vitest";
import { langFor, escapeHtml, hl, renderMarkdown } from "../media/view/highlight.js";

describe("langFor", () => {
  it("maps an extension to its highlight language", () => {
    expect(langFor("src/a.ts")).toBe("typescript");
    expect(langFor("app/models/user.rb")).toBe("ruby");
    expect(langFor("Gemfile.lock")).toBe(null);
  });

  it("ignores case and takes the last extension", () => {
    expect(langFor("A.TS")).toBe("typescript");
    expect(langFor("archive.tar.rb")).toBe("ruby");
  });

  it("returns null for an unknown or missing extension", () => {
    expect(langFor("Makefile")).toBe(null);
    expect(langFor("weird.qqq")).toBe(null);
  });
});

describe("escapeHtml", () => {
  it("neutralises markup so diff text cannot inject nodes", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert("x")&lt;/script&gt;',
    );
    expect(escapeHtml("a && b < c")).toBe("a &amp;&amp; b &lt; c");
  });
});

describe("hl", () => {
  it("highlights known languages", () => {
    expect(hl("const a = 1;", "typescript")).toContain("hljs-keyword");
  });

  it("escapes instead of highlighting when there is no language", () => {
    expect(hl("<b>x</b>", null)).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("falls back to escaped text for an unregistered language", () => {
    expect(hl("<b>x</b>", "klingon")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("passes empty text through", () => {
    expect(hl("", "typescript")).toBe("");
  });
});

describe("renderMarkdown", () => {
  it("renders lists, code and links", () => {
    const html = renderMarkdown("- one\n- two\n\n`code`\n\nhttps://example.com");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com"');
  });

  it("treats a single newline as a line break", () => {
    expect(renderMarkdown("one\ntwo")).toContain("<br>");
  });

  it("escapes raw HTML rather than trusting comment text", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("highlights fenced code blocks by language", () => {
    expect(renderMarkdown("```ts\nconst a = 1;\n```")).toContain("hljs-keyword");
  });
});
