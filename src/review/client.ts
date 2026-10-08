export type ClientConfig = { readonly mode: "mock" } | { readonly mode: "live"; readonly endpoint: string };

export type DecisionRequest = {
  /** Cards are keyed by fingerprint: unique among pending proposals, unlike ids reused across runs. */
  readonly fingerprint: string;
  readonly decision: "accepted" | "rejected";
  readonly reason: string | null;
  /** New text of each edit, in op order, when the human edited the proposal before accepting. */
  readonly newTexts: readonly string[] | null;
};

export type DecisionReply =
  | { readonly ok: true; readonly commit: string | null; readonly followUp: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Runs in the browser. Serialized with `toString()`, so it must not reference anything outside its body. */
export function reviewClient(config: ClientConfig): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-card]"));
  const progress = document.querySelector<HTMLElement>("[data-progress]");
  const done = document.querySelector<HTMLElement>("[data-done]");

  const refreshProgress = (): void => {
    const decided = cards.filter(
      (card) => card.dataset["state"] === "accepted" || card.dataset["state"] === "rejected",
    );
    if (progress) progress.textContent = `${decided.length}/${cards.length} décidées`;
    if (done) done.hidden = decided.length < cards.length;
  };

  const send = async (request: DecisionRequest): Promise<DecisionReply> => {
    if (config.mode === "mock") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true, commit: null, followUp: [] };
    }
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const reply = (await response.json()) as DecisionReply;
      return response.ok || !reply.ok ? reply : { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  for (const card of cards) {
    const fingerprint = card.dataset["card"] ?? "";
    const panel = (name: string): HTMLElement | null => card.querySelector<HTMLElement>(`[data-panel="${name}"]`);
    const status = card.querySelector<HTMLElement>("[data-status]");
    const errorLine = card.querySelector<HTMLElement>("[data-error]");
    const reasonInput = card.querySelector<HTMLInputElement>("[data-reason]");
    const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>("button"));

    const show = (name: "actions" | "edit" | "reject"): void => {
      for (const candidate of ["actions", "edit", "reject"]) {
        const element = panel(candidate);
        if (element) element.hidden = candidate !== name;
      }
      if (errorLine) errorLine.textContent = "";
      if (name === "reject") reasonInput?.focus();
    };

    const decide = async (request: DecisionRequest): Promise<void> => {
      for (const button of buttons) button.disabled = true;
      if (errorLine) errorLine.textContent = "";
      const reply = await send(request);
      if (!reply.ok) {
        for (const button of buttons) button.disabled = false;
        if (errorLine) errorLine.textContent = `Échec : ${reply.error}`;
        return;
      }
      card.dataset["state"] = request.decision;
      if (status) {
        status.replaceChildren();
        const head = document.createElement("strong");
        head.textContent = request.decision === "accepted" ? "Acceptée" : "Rejetée";
        status.append(head);
        const detail = document.createElement("span");
        if (request.decision === "rejected") detail.textContent = ` · « ${request.reason ?? ""} »`;
        else if (reply.commit) detail.textContent = ` · commit ${reply.commit.slice(0, 7)}`;
        else detail.textContent = config.mode === "mock" ? " · maquette : aucun commit" : " · rien à écrire";
        status.append(detail);
        for (const command of reply.followUp) {
          const line = document.createElement("code");
          line.textContent = command;
          status.append(document.createElement("br"), "Ensuite : ", line);
        }
      }
      refreshProgress();
    };

    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const why = target.closest<HTMLElement>("[data-why]");
      if (why) why.classList.toggle("open");
      const chip = target.closest<HTMLElement>("[data-chip]");
      if (chip && reasonInput) {
        reasonInput.value = chip.dataset["chip"] ?? "";
        reasonInput.focus();
        if (errorLine) errorLine.textContent = "";
      }
      const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset["action"];
      if (action === "accept") void decide({ fingerprint, decision: "accepted", reason: null, newTexts: null });
      if (action === "edit") show("edit");
      if (action === "reject") show("reject");
      if (action === "cancel") show("actions");
      if (action === "accept-edited") {
        const newTexts = Array.from(card.querySelectorAll<HTMLTextAreaElement>("textarea[data-edit]")).map(
          (area) => area.value,
        );
        void decide({ fingerprint, decision: "accepted", reason: null, newTexts });
      }
      if (action === "confirm-reject") {
        const reason = reasonInput?.value.trim() ?? "";
        if (reason === "") {
          if (errorLine) errorLine.textContent = "Une raison est requise : elle évite de reproposer la même chose.";
          reasonInput?.focus();
          return;
        }
        void decide({ fingerprint, decision: "rejected", reason, newTexts: null });
      }
    });

    reasonInput?.addEventListener("input", () => {
      if (errorLine) errorLine.textContent = "";
    });
    reasonInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") card.querySelector<HTMLButtonElement>('button[data-action="confirm-reject"]')?.click();
      if (event.key === "Escape") show("actions");
    });
  }

  document.querySelector<HTMLButtonElement>("[data-next]")?.addEventListener("click", () => location.reload());
  refreshProgress();
}
