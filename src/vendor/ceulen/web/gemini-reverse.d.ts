// The Gemini ask/research transport lives in the optional `gemini-reverse`
// package, imported dynamically only when web_research runs. Declared here so
// the bundle type-checks (and web_chat works) without installing it; install it
// before shipping the research tool.
declare module "gemini-reverse";
