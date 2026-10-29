/** The resource does not exist *for this actor*. Foreign and missing resources are deliberately indistinguishable. */
export class NotFoundError extends Error {
  constructor(what = "Not found") { super(what); }
}
