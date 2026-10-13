import type { CreateRule, ESTree } from "@oxlint/plugins";

const UPPER_CASE = /^[A-Z][A-Z0-9_]*$/;

function isLiteralValue(init: ESTree.Expression): boolean {
  if (init.type === "TemplateLiteral") {
    return init.expressions.length === 0;
  }

  if (init.type !== "Literal") {
    return false;
  }

  return (
    "regex" in init ||
    typeof init.value === "string" ||
    typeof init.value === "number" ||
    typeof init.value === "boolean"
  );
}

function isModuleConstant(node: ESTree.VariableDeclarator): boolean {
  const declaration = node.parent;

  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
    return false;
  }

  const holder = declaration.parent.type === "ExportNamedDeclaration" ? declaration.parent.parent : declaration.parent;

  return holder.type === "Program";
}

export const constantCaseRule: CreateRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require UPPER_CASE names for module-level constants that hold a literal.",
    },
    messages: {
      constantCase: "`{{name}}` is a module constant holding a literal: name it in UPPER_CASE.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init === null || UPPER_CASE.test(node.id.name)) {
          return;
        }

        if (isModuleConstant(node) && isLiteralValue(node.init)) {
          context.report({ node: node.id, messageId: "constantCase", data: { name: node.id.name } });
        }
      },
    };
  },
};
