export type DiffLine = {
  readonly kind: "same" | "del" | "add";
  readonly text: string;
};

function lines(text: string): readonly string[] {
  return text === "" ? [] : text.split("\n");
}

export function lineDiff(oldText: string, newText: string): readonly DiffLine[] {
  const before = lines(oldText);
  const after = lines(newText);
  const width = after.length + 1;
  const common = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i * width + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] ?? "";
    const right = after[j] ?? "";
    if (left === right) {
      diff.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      diff.push({ kind: "del", text: left });
      i++;
    } else {
      diff.push({ kind: "add", text: right });
      j++;
    }
  }
  for (; i < before.length; i++) diff.push({ kind: "del", text: before[i] ?? "" });
  for (; j < after.length; j++) diff.push({ kind: "add", text: after[j] ?? "" });
  return diff;
}
