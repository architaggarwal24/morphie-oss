/** Shared, deliberately simple text analysis used by memory recall and document search. */

const STOP = new Set(
  ("a an the is are was were be been being i you he she it we they me him her us them my your his its our their to of in on for with at by from as and or but " +
   "what which who whom whose how why when where this that these those do does did have has had will would should could can may might must not no so if then all about " +
   "please tell give show find need want like just some any also very more most than too get got make made let lets").split(" "),
);

/** Cheap suffix stripping so "baking", "baked", "bake" and "bakes" meet at "bak". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4) w = w.replace(/(ing|ed|es|ly|s)$/, "");
  else if (w.length > 3) w = w.replace(/s$/, "");
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1);
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of words(text)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}
