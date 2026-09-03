/**
 * Node implementations of the core's ports.
 *
 * This layer depends inward on `src/core`. The core never imports from here.
 */

export { NodeFileSystem } from './node-filesystem.js';
export { NodeCommandRunner } from './node-command-runner.js';
export { NodeGit, parseNumstat, parseStatus, type NodeGitOptions } from './node-git.js';
