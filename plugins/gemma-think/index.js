// Gemma is a bit special. it sends special stuff to think.
// this little script makes sure that thinking blocks show up correctly
// credit: https://antonioleiva.com/enable-gemma-thinking-mode-lm-studio-opencode
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "gemma.think",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      if (!['gemma-4-26b-a4b-it', 'gemma-4-e4b-it'].includes(event.model.id)) return;
      const messages = event.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;

      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") return;

      const index = last.content.findIndex((part) => part.type === "text");
      const firstTextPart = last.content[index];
      if (!firstTextPart) return;

      if (firstTextPart.type !== "text") return;
      if (firstTextPart.text.startsWith("<|think|>")) return;

      // Protocol message parts are immutable; replace the message draft.
      messages[messages.length - 1] = {
        ...last,
        content: last.content.map((part, i) => i === index
          ? { ...firstTextPart, text: `<|think|> ${firstTextPart.text}` } : part),
      };
    }, { providerID: "lmstudio" });
  },
});
