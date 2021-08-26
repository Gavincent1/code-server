/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { hostname, release } from 'os';
import * as path from 'path';
import { Schemas } from 'vs/base/common/network';
import { createServerURITransformer } from 'vs/base/common/uriServer';
import { getMachineId } from 'vs/base/node/id';
import { IServerChannel, ProxyChannel } from 'vs/base/parts/ipc/common/ipc';
import { LogsDataCleaner } from 'vs/code/electron-browser/sharedProcess/contrib/logsDataCleaner';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { ConsoleMainLogger, getLogLevel, ILoggerService, ILogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { LogLevelChannel } from 'vs/platform/log/common/logIpc';
import { LoggerService } from 'vs/platform/log/node/loggerService';
import { SpdLogLogger } from 'vs/platform/log/node/spdlogLog';
import product from 'vs/platform/product/common/product';
import { IProductService } from 'vs/platform/product/common/productService';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { RequestService } from 'vs/platform/request/node/requestService';
import { resolveCommonProperties } from 'vs/platform/telemetry/common/commonProperties';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryLogAppender } from 'vs/platform/telemetry/common/telemetryLogAppender';
import { TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { combinedAppender, NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import ErrorTelemetry from 'vs/platform/telemetry/node/errorTelemetry';
import { PtyHostService } from 'vs/platform/terminal/node/ptyHostService';
import { ExtensionEnvironmentChannel, FileProviderChannel, TerminalProviderChannel } from 'vs/server/channel';
import { TelemetryClient } from 'vs/server/insights';
import { REMOTE_TERMINAL_CHANNEL_NAME } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';
import { BufferLogService } from 'vs/platform/log/common/bufferLog';
import { setUnexpectedErrorHandler } from '../base/common/errors';
import * as proxyAgent from 'vs/base/node/proxy_agent';
import { enableCustomMarketplace } from 'vs/server/marketplace';
import { combinedDisposable, Disposable } from 'vs/base/common/lifecycle';
import { toErrorMessage } from '../base/common/errorMessage';
import { IInstantiationService, ServicesAccessor } from '../platform/instantiation/common/instantiation';
import { gracefulify } from 'graceful-fs';
import { IEnvironmentServerService, EnvironmentServerService } from './serverEnvironmentService';
import { ServerConfiguration } from './types';
import { WebSocketServer } from './connectionHandler';
import { Server as NetServer } from 'http';

const commit = product.commit || 'development';

enableCustomMarketplace();
proxyAgent.monkeyPatch(true);

/**
 * Handles client connections to a editor instance via IPC.
 */
export class ServerProcessMain extends Disposable {
	constructor(private readonly configuration: ServerConfiguration) {
		super();

		// Enable gracefulFs
		gracefulify(fs);

		this.registerListeners();
	}

	private registerListeners(): void {
		// Dispose on exit
		process.once('exit', () => this.dispose());
	}

	public async startup(netServer: NetServer) {
		// Services
		const [instantiationService, environmentServerService, bufferLogService] = await this.createServices();

		// Config
		// registerUserDataSyncConfiguration();

		instantiationService.invokeFunction(accessor => {
			const logService = accessor.get(ILogService);
			const ipcServer = new WebSocketServer(netServer, environmentServerService, logService);

			// Log info
			logService.trace('sharedProcess configuration', JSON.stringify(this.configuration));

			// Channels
			this.initChannels(ipcServer, accessor);

			// Error handler
			this.registerErrorHandler(logService);

			// Delay creation of spdlog for perf reasons (https://github.com/microsoft/vscode/issues/72906)
			bufferLogService.logger = new SpdLogLogger('main', path.join(environmentServerService.logsPath, `${RemoteExtensionLogFileName}.log`), true, bufferLogService.getLevel());

			// Instantiate Contributions
			this._register(combinedDisposable(instantiationService.createInstance(LogsDataCleaner), instantiationService.createInstance(ErrorTelemetry), ipcServer));
		});
	}

	// References:
	// ../../electron-browser/sharedProcess/sharedProcessMain.ts#L148
	// ../../../code/electron-main/app.ts
	public async createServices(): Promise<[IInstantiationService, IEnvironmentServerService, BufferLogService]> {
		const services = new ServiceCollection();

		// Product
		const productService = { _serviceBrand: undefined, ...product };
		services.set(IProductService, productService);

		// Environment
		const environmentServerService = new EnvironmentServerService(this.configuration.args, productService);
		services.set(IEnvironmentServerService, environmentServerService);

		await Promise.all(
			environmentServerService.environmentPaths.map(p =>
				fs.mkdir(p, { recursive: true }).catch(error => {
					console.warn(error.message || error);
				}),
			),
		);

		// Loggers
		// src/vs/code/electron-main/main.ts#142
		const bufferLogService = new BufferLogService();
		const logService = new MultiplexLogService([new ConsoleMainLogger(getLogLevel(environmentServerService)), bufferLogService]);
		process.once('exit', () => logService.dispose());
		services.set(ILogService, logService);

		// Files
		const fileService = new FileService(logService);
		fileService.registerProvider(Schemas.file, new DiskFileSystemProvider(logService));

		const loggerService = new LoggerService(logService, fileService);

		services.set(ILogService, logService);
		services.set(ILoggerService, loggerService);

		const configurationService = new ConfigurationService(environmentServerService.settingsResource, fileService);
		await configurationService.initialize();
		services.set(IConfigurationService, configurationService);

		services.set(IRequestService, new SyncDescriptor(RequestService));
		services.set(IFileService, fileService);

		await configurationService.initialize();
		services.set(IConfigurationService, configurationService);

		const machineId = await getMachineId();

		const instantiationService = new InstantiationService(services);

		let telemetryService: ITelemetryService;

		if (!environmentServerService.isExtensionDevelopment && !environmentServerService.disableTelemetry && !!productService.enableTelemetry) {
			telemetryService = new TelemetryService(
				{
					appender: combinedAppender(new AppInsightsAppender('code-server', null, () => new TelemetryClient() as any), new TelemetryLogAppender(loggerService, environmentServerService)),
					sendErrorTelemetry: true,
					commonProperties: resolveCommonProperties(fileService, release(), hostname(), process.arch, commit, product.version, machineId, undefined, environmentServerService.installSourcePath, 'code-server'),
					piiPaths: environmentServerService.piiPaths,
				},
				configurationService,
			);
		} else {
			telemetryService = NullTelemetryService;
		}

		services.set(ITelemetryService, telemetryService);

		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));
		services.set(ILocalizationsService, new SyncDescriptor(LocalizationsService));

		return [instantiationService, environmentServerService, bufferLogService];
	}

	private initChannels(ipcServer: WebSocketServer, accessor: ServicesAccessor): void {
		ipcServer.registerChannel('logger', new LogLevelChannel(accessor.get(ILogService)));
		ipcServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

		ipcServer.registerChannel('extensions', new ExtensionManagementChannel(accessor.get(IExtensionManagementService), context => createServerURITransformer(context.remoteAuthority)));
		ipcServer.registerChannel('remoteextensionsenvironment', new ExtensionEnvironmentChannel(accessor.get(IEnvironmentServerService), accessor.get(ILogService), accessor.get(ITelemetryService), ''));
		ipcServer.registerChannel('request', new RequestChannel(accessor.get(IRequestService)));
		ipcServer.registerChannel('localizations', <IServerChannel<any>>ProxyChannel.fromService(accessor.get(ILocalizationsService)));
		ipcServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new FileProviderChannel(accessor.get(IEnvironmentServerService), accessor.get(ILogService)));

		const ptyHostService = new PtyHostService({ GraceTime: 60000, ShortGraceTime: 6000 }, accessor.get(IConfigurationService), accessor.get(ILogService), accessor.get(ITelemetryService));
		ipcServer.registerChannel(REMOTE_TERMINAL_CHANNEL_NAME, new TerminalProviderChannel(accessor.get(ILogService), ptyHostService));
	}

	private registerErrorHandler(logService: ILogService): void {
		// Install handler for unexpected errors
		setUnexpectedErrorHandler(error => {
			const message = toErrorMessage(error, true);
			if (!message) {
				return;
			}

			logService.error(`[uncaught exception in sharedProcess]: ${message}`);
		});
	}

	dispose() {
		this.super.dispose();
	}
}
