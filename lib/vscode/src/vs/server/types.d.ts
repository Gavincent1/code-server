/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Server } from 'http';
import { NativeParsedArgs } from '../platform/environment/common/argv';

export interface StartPath {
	url: string;
	workspace: boolean;
}

export interface ServerConfiguration {
	args: NativeParsedArgs;
	authed: boolean;
	base: string;
	csStaticBase: string;
	disableUpdateCheck: boolean;
	logLevel: number;
	remoteAuthority: string;
	startPath?: StartPath;
	codeServerVersion: string;
}

/**
 * @deprecated This primarily exists to bridge the gap between code-server and lib/vscode
 */

export type CreateVSServer = (serverConfiguration: ServerConfiguration) => Promise<Server>;

/**
 * Base options included on every page.
 */
export type ClientConfiguration = Pick<ServerConfiguration, 'base' | 'csStaticBase' | 'logLevel' | 'codeServerVersion'>;

export interface CliMessage {
	type: 'cli';
	args: NativeParsedArgs;
}

export interface OpenCommandPipeArgs {
	type: 'open';
	fileURIs?: string[];
	folderURIs: string[];
	forceNewWindow?: boolean;
	diffMode?: boolean;
	addMode?: boolean;
	gotoLineMode?: boolean;
	forceReuseWindow?: boolean;
	waitMarkerFilePath?: string;
}
