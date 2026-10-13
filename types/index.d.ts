export type ReviewEvidence = {
  readonly kind: "quote" | "observation";
  readonly at: string;
  readonly text: string;
  readonly message: string | null;
  readonly tool: string | null;
};

export type ReviewEdit = { readonly oldText: string; readonly newText: string };

export type ReviewChange =
  | { readonly kind: "edit"; readonly edits: readonly ReviewEdit[] }
  | { readonly kind: "description"; readonly text: string };

export type ReviewItem = {
  readonly id: string;
  readonly targetPath: string;
  readonly repoRoot: string | null;
  readonly verdict: string | null;
  readonly source: string;
  readonly claimFr: string;
  readonly reasoningFr: string;
  readonly lessonEn: string;
  readonly change: ReviewChange;
  readonly evidence: readonly ReviewEvidence[];
  readonly prevalence: { readonly sessions: number; readonly days: number; readonly repos: number };
};

export type ReviewMode =
  | { readonly kind: "view" }
  | { readonly kind: "edit" }
  | { readonly kind: "reject" }
  | { readonly kind: "busy"; readonly label: string };

export type ReviewState = {
  readonly items: readonly ReviewItem[];
  readonly index: number;
  readonly mode: ReviewMode;
  readonly expanded: readonly number[];
  readonly notice: string | null;
  readonly pending: number;
};

declare module "claude-code" {
  interface PluginState {
    hindsight: { review: ReviewState };
  }
}
