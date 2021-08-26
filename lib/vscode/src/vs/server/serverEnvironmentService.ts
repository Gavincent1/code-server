/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';
import { createServerURITransformer } from 'vs/base/common/uriServer';
import { NativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { getLogLevel } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { toWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { getLocaleFromConfig, getNlsConfiguration } from 'vs/server/nls';
import { IServerWorkbenchConstructionOptions, IWorkspace } from 'vs/workbench/workbench.web.api';
import { memoize } from '../base/common/decorators';
import { INativeEnvironmentService } from '../platform/environment/common/environment';
import { refineServiceDecorator } from '../platform/instantiation/common/instantiation';
import { ServerConfiguration } from './types';

const commit = product.commit || 'development';

export interface IEnvironmentServerService extends INativeEnvironmentService {
	extraExtensionPaths: string[];
	extraBuiltinExtensionPaths: string[];
	extensionEnabledProposedApi: string[] | undefined;
}

export const IEnvironmentServerService = refineServiceDecorator<INativeEnvironmentService, IEnvironmentServerService>(INativeEnvironmentService);

export class EnvironmentServerService extends NativeEnvironmentService {
	public async createWorkbenchConstructionOptions({ remoteAuthority, startPath, csStaticBase }: ServerConfiguration): Promise<IServerWorkbenchConstructionOptions> {
		const serverUrl = new URL(`http://${remoteAuthority}`);

		const transformer = createServerURITransformer(remoteAuthority);

		const webEndpointUrl = new URL(serverUrl.toString());
		webEndpointUrl.pathname = path.join(csStaticBase, 'lib/vscode');

		/**
		 * A workspace to open in the workbench can either be:
		 * - a workspace file with 0-N folders (via `workspaceUri`)
		 * - a single folder (via `folderUri`)
		 * - empty (via `undefined`)
		 */

		let workspace: IWorkspace | undefined = undefined;

		if (startPath) {
			const workbenchURIs = this.createWorkbenchURIs([startPath.url]);

			// TODO: multiple workbench entries needs further testing.
			// const hasSingleEntry = workbenchURIs.length > 0;
			// const isSingleEntry = workbenchURIs.length === 1;

			workspace = {
				// workspaceUri: isSingleEntry ? undefined : fs.stat(path),
				workspaceUri: undefined,
				folderUri: workbenchURIs[0].uri,
			};
		}

		return {
			...workspace,
			remoteAuthority: this.args.remote,
			logLevel: getLogLevel(this),
			workspaceProvider: {
				workspace,
				trusted: undefined,
				payload: [
					['userDataPath', this.userDataPath],
					['enableProposedApi', JSON.stringify(this.extensionEnabledProposedApi || [])],
				],
			},
			remoteUserDataUri: transformer.transformOutgoing(URI.file(this.userDataPath)),
			productConfiguration: {
				...product,
				webEndpointUrl: webEndpointUrl.toJSON(),
			},
			nlsConfiguration: await getNlsConfiguration(this.args.locale || (await getLocaleFromConfig(this.userDataPath)), this.userDataPath),
			commit,
		};
	}

	private createWorkbenchURIs(paths: string[]) {
		return paths.map(path =>
			toWorkspaceFolder(
				URI.from({
					scheme: Schemas.vscodeRemote,
					authority: remoteAuthority,
					path,
				}),
			),
		);
	}

	@memoize
	public get environmentPaths(): string[] {
		return [this.extensionsPath, this.logsPath, this.globalStorageHome.fsPath, this.workspaceStorageHome.fsPath, ...this.extraExtensionPaths, ...this.extraBuiltinExtensionPaths];
	}

	@memoize
	public get piiPaths(): string[] {
		return [
			path.join(this.userDataPath, 'clp'), // Language packs.
			this.appRoot,
			this.extensionsPath,
			this.builtinExtensionsPath,
			...this.extraExtensionPaths,
			...this.extraBuiltinExtensionPaths,
		];
	}
}
