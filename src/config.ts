import type { AppConfig } from './types';

// The build prepends this value from config-header.ts. Keeping the declaration
// here gives application code a checked configuration without bundling a second
// copy of the values into the release artifact.
declare const WIIM_CONFIG: AppConfig;

export default WIIM_CONFIG;
