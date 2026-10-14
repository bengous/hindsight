import type { JsonValue } from "../domain/json.ts";
import type { ReviewState } from "./host.ts";
import type { Elements, RenderElement } from "claude-code";

import { unifiedDiff } from "../domain/diff.ts";
import { isJsonObject, isNumber, isString } from "../domain/json.ts";
import { displayText } from "../domain/text.ts";

/** The elements the pane draws with: present on every surface except `Input`, which mobile does not draw. */
export type PaneElements = Pick<Elements["mobile"], "Box" | "Text" | "Button" | "Code"> &
  Partial<Pick<Elements["terminal"], "Input">>;

export type PaneItem = ReviewState["items"][number];

export type PaneMode = ReviewState["mode"];

export type PaneEvidence = PaneItem["evidence"][number];

export type PaneEdit = Extract<PaneItem["change"], { kind: "edit" }>["edits"][number];

export type ReviewActions = {
  readonly accept: (edits: readonly PaneEdit[] | null) => void;
  readonly acceptEdited: () => void;
  readonly reject: (reason: string) => void;
  readonly handoff: () => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly edit: () => void;
  readonly setMode: (mode: PaneMode) => void;
  readonly toggleEvidence: (index: number) => void;
  readonly toggleFold: () => void;
  readonly setDraft: (index: number, value: string) => void;
};

export const emptyReview: ReviewState = {
  items: [],
  index: 0,
  mode: { kind: "view" },
  expanded: [],
  folded: true,
  notice: null,
  pending: 0,
};

export const REJECT_REASONS = ["Pas une règle", "Déjà couvert", "Trop lié à une session", "Faux positif"] as const;

const plural = (count: number, word: string): string => `${count} ${word}${count > 1 ? "s" : ""}`;

export function prevalenceLine(prevalence: { sessions: number; days: number; repos: number }): string {
  if (prevalence.sessions === 0) {
    return "vérifié par le code";
  }

  return `vu dans ${plural(prevalence.sessions, "session")} sur ${plural(prevalence.days, "jour")}, ${plural(prevalence.repos, "dépôt")}`;
}

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** The day and month of an ISO date or datetime, read from its text: a timezone would move the day. */
export function shortDate(iso: string): string {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(iso) ?? [];
  const name = MONTHS[Number(month) - 1];

  return name === undefined || day === undefined ? iso : `${Number(day)} ${name}`;
}

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

function isPaneEdit(value: JsonValue): value is PaneEdit {
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

/** The Decision row: an edit is accepted, modified, rejected or handed off; a description only handed off or rejected. */
function viewActions(el: PaneElements, isEdit: boolean, actions: ReviewActions): RenderElement {
  const { Box, Button } = el;

  return (
    <Box flexDirection="row" gap={1}>
      {isEdit && (
        <Button key="accept" hotkey="a" variant="primary" onPress={() => actions.accept(null)}>
          Accepter
        </Button>
      )}
      {isEdit && (
        <Button key="edit" hotkey="m" onPress={() => actions.edit()}>
          Modifier
        </Button>
      )}
      <Button key="reject" hotkey="r" onPress={() => actions.setMode({ kind: "reject" })}>
        Rejeter
      </Button>
      <Button
        key="handoff"
        hotkey="h"
        {...(isEdit ? {} : { variant: "primary" as const })}
        onPress={() => actions.handoff()}
      >
        {isEdit ? "Handoff" : "Ajouter au Handoff"}
      </Button>
      <Button key="previous" hotkey="p" onPress={() => actions.previous()}>
        Précédent
      </Button>
      <Button key="next" hotkey="n" onPress={() => actions.next()}>
        Suivant
      </Button>
    </Box>
  );
}

export function drawReview(
  el: PaneElements,
  state: ReviewState,
  drafts: readonly string[],
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
  const path = displayPath(item.targetPath, item.repoRoot);

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>
          {path} <Text dimColor>{item.repoRoot ?? "global"}</Text>
        </Text>
        <Text dimColor>
          {state.index + 1} sur {state.items.length}
        </Text>
      </Box>
      {item.change.kind === "edit" ? (
        <Box borderStyle="single" borderDimColor paddingX={1}>
          <Code source={unifiedDiff(path, item.change.edits)} format="diff" path={path} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>{displayText(item.change.text, TEXT_MAX)}</Text>
          <Text dimColor>Ce changement se fait dans un Handoff, pas par une édition de texte.</Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Text>{displayText(item.claimFr, TEXT_MAX)}</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {item.evidence.map((evidence, index) => (
            <Box flexDirection="column" key={`ev-${index}`}>
              <Button key={`evidence-${index}`} plain onPress={() => actions.toggleEvidence(index)}>
                {state.expanded.includes(index) ? "▾ " : "▸ "}
                {evidence.kind === "quote" ? "« " : `${evidence.tool ?? "outil"} › `}
                {displayText(evidence.text, TEXT_MAX)}
                {evidence.kind === "quote" ? " »" : ""} <Text dimColor>{shortDate(evidence.at)}</Text>
              </Button>
              {state.expanded.includes(index) && evidence.message !== null && (
                <Text dimColor>{displayText(evidence.message, MESSAGE_MAX)}</Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
      <Box flexDirection="column">
        <Button key="fold" plain onPress={() => actions.toggleFold()}>
          {state.folded ? "▸ " : "▾ "}Raisonnement et Lesson
        </Button>
        {!state.folded && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor>{displayText(item.reasoningFr, TEXT_MAX)}</Text>
            <Text dimColor>Lesson: {displayText(item.lessonEn, TEXT_MAX)}</Text>
          </Box>
        )}
      </Box>
      <Text dimColor>
        {item.verdict ?? item.source} · {prevalenceLine(item.prevalence)}
      </Text>
      {state.notice !== null && <Text color="warning">{displayText(state.notice, TEXT_MAX)}</Text>}
      {state.mode.kind === "view" && viewActions(el, isEdit, actions)}
      {state.mode.kind === "edit" && item.change.kind === "edit" && (
        <Box flexDirection="column">
          <Text dimColor>Nouveau texte, une ligne par modification ; ⏎ marque un saut de ligne.</Text>
          {Input !== undefined &&
            drafts.map((draft, index) => (
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
          <Text dimColor>Pourquoi ce rejet ?</Text>
          {REJECT_REASONS.map((reason, index) => (
            <Button key={`reason-${index}`} hotkey={String(index + 1)} plain onPress={() => actions.reject(reason)}>
              {reason}
            </Button>
          ))}
          {Input !== undefined && (
            <Button
              key="reject-other"
              hotkey={String(REJECT_REASONS.length + 1)}
              plain
              onPress={() => actions.setMode({ kind: "reject-other" })}
            >
              Autre…
            </Button>
          )}
          <Button key="cancel-reject" onPress={() => actions.setMode({ kind: "view" })}>
            Annuler
          </Button>
        </Box>
      )}
      {state.mode.kind === "reject-other" && (
        <Box flexDirection="column">
          {Input !== undefined && (
            <Input
              key="reject-reason"
              label="Autre raison"
              placeholder="une phrase, gardée dans le Ledger"
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
