type Content = import("../scripts/content").RhueContent;

declare module "virtual:rhue-content" {
  const content: Pick<Content, "meta" | "next" | "bench" | "samples"> & {
    changelog: { source: Content["changelog"]["source"]; entries: Omit<Content["changelog"]["entries"][number], "html">[] };
  };
  export default content;
}
declare module "virtual:rhue-content/design" {
  const design: Content["design"];
  export default design;
}
declare module "virtual:rhue-content/changelog" {
  const changelog: Content["changelog"];
  export default changelog;
}
