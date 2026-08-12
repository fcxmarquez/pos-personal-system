import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function selectionBody(source: string) {
  const start = source.indexOf("{");
  let depth = 0;

  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth === 0) return source.slice(start + 1, index);
  }

  throw new Error("Expected a balanced GraphQL selection");
}

function directFieldSelection(source: string, field: string) {
  let depth = 0;

  for (let index = 0; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth !== 0 || !source.slice(index).match(/^[_A-Za-z][_0-9A-Za-z]*/)) {
      continue;
    }

    const name = source.slice(index).match(/^[_A-Za-z][_0-9A-Za-z]*/)?.[0];
    if (name === field) return selectionBody(source.slice(index + name.length));
    index += (name?.length ?? 1) - 1;
  }

  throw new Error(`Expected direct GraphQL field ${field}`);
}

describe("engage-pr-comments GraphQL pagination contract", () => {
  test("exposes pagination metadata and an explicit reply-page request", () => {
    const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    const requests = [...skill.matchAll(/```graphql\s*([\s\S]*?)```/g)].map(
      (match) => match[1]
    );
    const initialRequestIndex = requests.findIndex((request) =>
      request.includes("reviewThreads")
    );
    expect(initialRequestIndex).toBeGreaterThanOrEqual(0);

    const operation = selectionBody(requests[initialRequestIndex]);
    const repository = directFieldSelection(operation, "repository");
    const pullRequest = directFieldSelection(repository, "pullRequest");
    const reviewThreads = directFieldSelection(pullRequest, "reviewThreads");
    const threadNodes = directFieldSelection(reviewThreads, "nodes");
    const comments = directFieldSelection(threadNodes, "comments");

    for (const connection of [reviewThreads, comments]) {
      const pageInfo = directFieldSelection(connection, "pageInfo");
      expect(pageInfo).toMatch(/\bhasNextPage\b/);
      expect(pageInfo).toMatch(/\bendCursor\b/);
    }

    const replyPageRequest = requests
      .slice(initialRequestIndex + 1)
      .find((request) => /\bcomments\s*\(/.test(request));
    expect(
      replyPageRequest,
      "Expected a subsequent reply-page GraphQL request with comments(first: 100, after: $replyCursor)"
    ).toMatch(/\bcomments\s*\(\s*first\s*:\s*100\s*,\s*after\s*:\s*\$replyCursor\s*\)/);
  });
});
