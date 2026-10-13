import type { JsonValue } from "../domain/json.ts";
import type { Elements, RenderElement } from "claude-code";

import { toDraft, unifiedDiff } from "../domain/diff.ts";
import { isJsonObject, isNumber, isString } from "../domain/json.ts";
import { displayText } from "../domain/text.ts";

/** The elements the pane draws with: present on every surface except `Input`, which mobile does not draw. */
export type PaneElements = Pick<Elements["mobile"], "Box" | "Text" | "Button" | "Code"> &
  Partial<Pick<Elements["terminal"], "Input">>;

export type PaneEvidence = {
  readonly kind: "quote" | "observation";
  readonly at: string;
  readonly text: string;
  readonly message: string | null;
  readonly tool: string | null;
};

export type PaneItem = {
  readonly id: string;
  readonly targetPath: string;
  readonly repoRoot: string | null;
  readonly verdict: string | null;
  readonly source: string;
  readonly claimFr: string;
  readonly reasoningFr: string;
  readonly lessonEn: string;
  readonly change:
    | { readonly kind: "edit"; readonly edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string }> }
    | { readonly kind: "description"; readonly text: string };
  readonly evidence: readonly PaneEvidence[];
  readonly prevalence: { readonly sessions: number; readonly days: number; readonly repos: number };
};

export type PaneMode =
  | { readonly kind: "view" }
  | { readonly kind: "edit"; readonly drafts: readonly string[] }
  | { readonly kind: "reject" }
  | { readonly kind: "busy"; readonly label: string };

export type ReviewState = {
  readonly items: readonly PaneItem[];
  readonly index: number;
  readonly mode: PaneMode;
  readonly expanded: readonly number[];
  readonly notice: string | null;
  readonly pending: number;
};

export type ReviewActions = {
  readonly accept: (edits: ReadonlyArray<{ oldText: string; newText: string }> | null) => void;
  readonly acceptEdited: () => void;
  readonly reject: (reason: string) => void;
  readonly handoff: () => void;
  readonly next: () => void;
  readonly setMode: (mode: PaneMode) => void;
  readonly toggleEvidence: (index: number) => void;
  readonly setDraft: (index: number, value: string) => void;
};

export const emptyReview: ReviewState = {
  items: [],
  index: 0,
  mode: { kind: "view" },
  expanded: [],
  notice: null,
  pending: 0,
};

const isTextOrNull = (value: JsonValue | undefined): value is string | null => value === null || isString(value);

function isPaneEvidence(value: JsonValue): value is PaneEvidence {
  return (
    isJsonObject(value) &&
    (value["kind"] === "quote" || value["kind"] === "observation") &&
    isString(value["at"]) &&
    isString(value["text"]) &&
    isTextOrNull(value["message"]) &&
    isTextOrNull(value["tool"])
  );
}

function isPaneEdit(value: JsonValue): value is { readonly oldText: string; readonly newText: string } {
  return isJsonObject(value) && isString(value["oldText"]) && isString(value["newText"]);
}

function isPaneChange(value: JsonValue | undefined): value is PaneItem["change"] {
  if (!isJsonObject(value)) {
    return false;
  }

  const edits = value["edits"];

  return value["kind"] === "edit"
    ? Array.isArray(edits) && edits.every(isPaneEdit)
    : value["kind"] === "description" && isString(value["text"]);
}

export function isPaneItem(value: JsonValue): value is PaneItem {
  if (!isJsonObject(value)) {
    return false;
  }

  const evidence = value["evidence"];
  const prevalence = value["prevalence"];

  return (
    isString(value["id"]) &&
    isString(value["targetPath"]) &&
    isTextOrNull(value["repoRoot"]) &&
    isTextOrNull(value["verdict"]) &&
    isString(value["source"]) &&
    isString(value["claimFr"]) &&
    isString(value["reasoningFr"]) &&
    isString(value["lessonEn"]) &&
    isPaneChange(value["change"]) &&
    Array.isArray(evidence) &&
    evidence.every(isPaneEvidence) &&
    isJsonObject(prevalence) &&
    isNumber(prevalence["sessions"]) &&
    isNumber(prevalence["days"]) &&
    isNumber(prevalence["repos"])
  );
}

const TEXT_MAX = 600;

const MESSAGE_MAX = 2000;

export function displayPath(path: string, repoRoot: string | null): string {
  if (repoRoot !== null && path.startsWith(`${repoRoot}/`)) {
    return path.slice(repoRoot.length + 1);
  }

  return path;
}

export function drawReview(
  el: PaneElements,
  state: ReviewState,
  actions: ReviewActions,
  bodyColumns: number,
): RenderElement {
  const { Box, Text, Button, Input, Code } = el;
  const width = Math.max(30, bodyColumns - 2);
  const item = state.items[state.index];

  if (item === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{state.notice ?? "Aucune Proposal en attente."}</Text>
      </Box>
    );
  }

  const isEdit = item.change.kind === "edit";

  const diff =
    item.change.kind === "edit" ? unifiedDiff(displayPath(item.targetPath, item.repoRoot), item.change.edits) : null;

  const prevalence =
    item.prevalence.sessions === 0
      ? "contrôle en code"
      : `${item.prevalence.sessions} session(s), ${item.prevalence.days} jour(s), ${item.prevalence.repos} dépôt(s)`;

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>
        {displayPath(item.targetPath, item.repoRoot)} <Text dimColor>{item.repoRoot ?? "fichier global"}</Text>
      </Text>
      <Text>
        <Text dimColor>
          {state.index + 1}/{state.items.length} ·{" "}
        </Text>
        {item.verdict ?? item.source} · {prevalence}
      </Text>
      <Text>{displayText(item.claimFr, TEXT_MAX)}</Text>
      {diff === null ? (
        <Text color="warning">{displayText(item.change.kind === "description" ? item.change.text : "", TEXT_MAX)}</Text>
      ) : (
        <Code source={diff} format="diff" path={displayPath(item.targetPath, item.repoRoot)} />
      )}
      <Text dimColor>{displayText(item.reasoningFr, TEXT_MAX)}</Text>
      <Text dimColor>Lesson: {displayText(item.lessonEn, TEXT_MAX)}</Text>
      {item.evidence.map((evidence, index) => (
        <Box flexDirection="column" key={`ev-${index}`}>
          <Button key={`evidence-${index}`} plain onPress={() => actions.toggleEvidence(index)}>
            {evidence.kind === "quote" ? "« " : `${evidence.tool ?? "outil"} › `}
            {displayText(evidence.text, TEXT_MAX)}
            {evidence.kind === "quote" ? " »" : ""} <Text dimColor>{evidence.at.slice(0, 10)}</Text>
          </Button>
          {state.expanded.includes(index) && evidence.message !== null && (
            <Text dimColor>{displayText(evidence.message, MESSAGE_MAX)}</Text>
          )}
        </Box>
      ))}
      {state.notice !== null && <Text color="warning">{displayText(state.notice, TEXT_MAX)}</Text>}
      {state.mode.kind === "view" && (
        <Box flexDirection="row" gap={1}>
          {isEdit && (
            <Button key="accept" hotkey="a" variant="primary" onPress={() => actions.accept(null)}>
              Accepter
            </Button>
          )}
          {isEdit && (
            <Button
              key="edit"
              hotkey="m"
              onPress={() =>
                actions.setMode({
                  kind: "edit",
                  drafts: item.change.kind === "edit" ? item.change.edits.map((edit) => toDraft(edit.newText)) : [],
                })
              }
            >
              Modifier
            </Button>
          )}
          <Button key="reject" hotkey="r" onPress={() => actions.setMode({ kind: "reject" })}>
            Rejeter
          </Button>
          <Button key="handoff" hotkey="h" onPress={() => actions.handoff()}>
            Handoff
          </Button>
          <Button key="next" hotkey="n" onPress={() => actions.next()}>
            Suivant
          </Button>
        </Box>
      )}
      {state.mode.kind === "edit" && item.change.kind === "edit" && (
        <Box flexDirection="column">
          <Text dimColor>Nouveau texte, une ligne par modification ; ⏎ marque un saut de ligne.</Text>
          {Input !== undefined &&
            state.mode.drafts.map((draft, index) => (
              <Input
                key={`draft-${index}`}
                label={`Modification ${index + 1}`}
                value={draft}
                {...(index === 0 ? { autoFocus: true as const } : {})}
                onInput={(value) => actions.setDraft(index, value)}
                onSubmit={(value) => actions.setDraft(index, value)}
              />
            ))}
          <Box flexDirection="row" gap={1}>
            <Button key="accept-edited" variant="primary" onPress={() => actions.acceptEdited()}>
              Accepter le texte modifié
            </Button>
            <Button key="cancel-edit" onPress={() => actions.setMode({ kind: "view" })}>
              Annuler
            </Button>
          </Box>
        </Box>
      )}
      {state.mode.kind === "reject" && (
        <Box flexDirection="column">
          {Input !== undefined && (
            <Input
              key="reject-reason"
              label="Raison du rejet"
              placeholder="obligatoire"
              autoFocus
              onSubmit={(value) => actions.reject(value)}
            />
          )}
          <Button key="cancel-reject" onPress={() => actions.setMode({ kind: "view" })}>
            Annuler
          </Button>
        </Box>
      )}
      {state.mode.kind === "busy" && <Text dimColor>{state.mode.label}</Text>}
    </Box>
  );
}
