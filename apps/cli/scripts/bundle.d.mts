export interface BundleOptions {
  /** The entry point, src/main.ts by default. */
  entry?: string;
  /** Where dist/, prompts/ and web/ go, this package's folder by default. */
  outDir?: string;
  /** The built web app to copy, apps/web/dist by default. */
  webDist?: string;
}

export function bundle(options?: BundleOptions): Promise<void>;
