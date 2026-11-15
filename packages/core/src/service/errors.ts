/**
 * An expected failure of a run action, worded for the person who asked (a wrong run id, a run in
 * the wrong state). Front ends show the message as it is: the CLI turns it into its own error.
 */
export class ServiceError extends Error {}
