/** A request the server can't act on as sent: a 400 with the message. */
export class BadRequest extends Error {}

/** The thing moved on since the page showed it, or is busy: a 409 with the message. */
export class Conflict extends Error {}
