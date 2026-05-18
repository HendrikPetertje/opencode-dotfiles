// Gemma is a bit special. it sends special stuff to think.
// this little script makes sure that thinking blocks show up correctly
// credit: https://antonioleiva.com/enable-gemma-thinking-mode-lm-studio-opencode
export const GemmaThinkPlugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      const last = messages[messages.length - 1];
      if (!last || last.info.role !== "user") return;

      const model = last.info.model;
      if (!model || model.providerID !== "lmstudio" || !['gemma-4-26b-a4b-it', 'gemma-4-e4b-it'].includes(model.modelID)) {
        return;
      }

      const firstTextPart = last.parts.find((part) => part.type === "text");
      if (!firstTextPart) return;

      if (typeof firstTextPart.text !== "string") return;
      if (firstTextPart.text.startsWith("<|think|>")) return;

      firstTextPart.text = `<|think|> ${firstTextPart.text}`;
    },
  };
};
