/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import { ClientConnectionEvent, IPCServer } from 'vs/base/parts/ipc/common/ipc';
import { ConsoleLogger } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { ConnectionType, connectionTypeToString, IRemoteExtensionHostStartParams } from 'vs/platform/remote/common/remoteAgentConnection';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { ConnectionOptions } from 'vs/server/connection/abstractConnection';
import { ServerProtocol } from 'vs/server/protocol';
import { NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { ExtensionHostConnection } from 'vs/server/connection/extensionHostConnection';
import { ManagementConnection } from 'vs/server/connection/managementConnection';
import { Event, Emitter } from 'vs/base/common/event';
import { IEnvironmentServerService } from './serverEnvironmentService';

type Connection = ExtensionHostConnection | ManagementConnection;

/**
 * Handles client connections to a editor instance via IPC.
 */
export class WebSocketServer extends IPCServer<RemoteAgentConnectionContext> {
	public readonly _onDidClientConnect = new Emitter<ClientConnectionEvent>();
	public readonly onDidClientConnect = this._onDidClientConnect.event;

	private readonly maxExtraOfflineConnections = 0;
	private readonly _connections = new Map<ConnectionType, Map<string, Connection>>();
	private server: NetServer | null;

	/**
	 * Initializes connection map for this type of connection.
	 */
	private getCachedConnectionMap<T extends ConnectionType>(desiredConnectionType: T) {
		let connectionMap = this.connections.get(desiredConnectionType);

		if (!connectionMap) {
			connectionMap = new Map<string, Connection>();
			this.connections.set(desiredConnectionType, connectionMap);
		}

		return connectionMap;
	}

	constructor(server: net.Server, private readonly environmentService: IEnvironmentServerService, private readonly logService: ConsoleLogger) {
		super(WebSocketServer.toClientConnectionEvent(server));
		this.server = server;
	}

	private static toClientConnectionEvent(server: net.Server): Event<ClientConnectionEvent> {
		const onUpgrade = Event.fromNodeEventEmitter<net.Socket>(server, 'upgrade');

		return Event.map(onUpgrade, socket => ({
			protocol: new Protocol(new NodeSocket(socket)),
			onDidClientDisconnect: Event.once(Event.fromNodeEventEmitter<void>(socket, 'close')),
		}));
	}

	public async handleWebSocket(socket: net.Socket, connectionOptions: ConnectionOptions, permessageDeflate = false): Promise<true> {
		const protocol = new ServerProtocol(new WebSocketNodeSocket(new NodeSocket(socket), permessageDeflate, null, permessageDeflate), this.logService, connectionOptions);

		try {
			await this.connect(protocol);
		} catch (error) {
			protocol.dispose(error.message);
		}
		return true;
	}

	private async connect(protocol: ServerProtocol): Promise<void> {
		const message = await protocol.handshake();

		const clientVersion = message.commit;
		const serverVersion = product.commit;
		if (serverVersion && clientVersion !== serverVersion) {
			this.logService.warn(`Client version (${message.commit} does not match server version ${serverVersion})`);
		}

		// `desiredConnectionType` is marked as optional,
		// but it's a scenario we haven't yet seen.
		if (!message.desiredConnectionType) {
			throw new Error(`Expected desired connection type in protocol handshake: ${JSON.stringify(message)}`);
		}

		const connections = this.getCachedConnectionMap(message.desiredConnectionType);
		let connection = connections.get(protocol.reconnectionToken);
		const logPrefix = connectLogPrefix(message.desiredConnectionType, protocol);

		if (protocol.reconnection && connection) {
			this.logService.info(logPrefix, 'Client attempting to reconnect');
			return connection.reconnect(protocol);
		}

		// This probably means the process restarted so the session was lost
		// while the browser remained open.
		if (protocol.reconnection) {
			throw new Error(`Unable to reconnect; session no longer exists (${protocol.reconnectionToken})`);
		}

		// This will probably never happen outside a chance collision.
		if (connection) {
			throw new Error('Unable to connect; token is already in use');
		}

		// Now that the initial exchange has completed we can create the actual
		// connection on top of the protocol then send it to whatever uses it.
		this.logService.info(logPrefix, 'Client requesting connection');

		switch (message.desiredConnectionType) {
			case ConnectionType.Management:
				connection = new ManagementConnection(protocol, this.logService);

				// The management connection is used by firing onDidClientConnect
				// which makes the IPC server become aware of the connection.
				this._onDidClientConnect.fire(<ClientConnectionEvent>{
					protocol,
					onDidClientDisconnect: connection.onClose,
				});
				break;
			case ConnectionType.ExtensionHost:
				// The extension host connection is used by spawning an extension host
				// and then passing the socket into it.

				const startParams: IRemoteExtensionHostStartParams = {
					language: 'en',
					...message.args,
				};

				connection = new ExtensionHostConnection(protocol, this.logService, startParams, this.environmentService);

				await connection.spawn();
				break;
			case ConnectionType.Tunnel:
				return protocol.tunnel();
			default:
				throw new Error(`Unknown desired connection type ${message.desiredConnectionType}`);
		}

		connections.set(protocol.reconnectionToken, connection);
		connection.onClose(() => connections.delete(protocol.reconnectionToken));

		this.disposeOldOfflineConnections(connections);
		this.logService.debug(`${connections.size} active ${connection.name} connection(s)`);
	}

	private disposeOldOfflineConnections(connections: Map<string, Connection>): void {
		const offline = Array.from(connections.values()).filter(connection => typeof connection.offline !== 'undefined');
		for (let i = 0, max = offline.length - this.maxExtraOfflineConnections; i < max; ++i) {
			offline[i].dispose('old');
		}
	}

	override dispose(): void {
		super.dispose();
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

function connectLogPrefix(connectionType: ConnectionType, protocol: ServerProtocol) {
	return `[${connectionTypeToString(connectionType)}] ${protocol.logPrefix}`;
}
