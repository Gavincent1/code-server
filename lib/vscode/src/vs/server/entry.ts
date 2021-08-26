import { ServerProcessMain } from './server';
import { ConnectionOptions, parseQueryConnectionOptions } from './connection/abstractConnection';
import { ServerConfiguration } from './types';
import { createReponseHeaders, UpgradeHandler } from './utils/websocket';
import { createServer } from 'http';
// eslint-disable-next-line code-import-patterns
import { requestHandler as defaultRequestHandler } from '../../../resources/web/code-web';
import { WebSocketServer } from './connectionHandler';

const logger = console;

export async function main(serverConfig: ServerConfiguration) {
	const serverUrl = new URL(`http://${serverConfig.server}`);

	const httpServer = createServer();

	const codeServer = new ServerProcessMain(serverConfig);
	await codeServer.startup(httpServer);

	const workbenchConstructionOptions = await codeServer.createWorkbenchConstructionOptions(serverUrl);

	httpServer.on('request', (req, res) => defaultRequestHandler(req, res, workbenchConstructionOptions));

	const upgrade: UpgradeHandler = (req, socket) => {
		if (req.headers['upgrade'] !== 'websocket' || !req.url) {
			logger.error(`failed to upgrade for header "${req.headers['upgrade']}" and url: "${req.url}".`);
			socket.end('HTTP/1.1 400 Bad Request');
			return;
		}

		const upgradeUrl = new URL(req.url, serverUrl.toString());
		logger.log('Upgrade from', upgradeUrl.toString());

		let connectionOptions: ConnectionOptions;

		try {
			connectionOptions = parseQueryConnectionOptions(upgradeUrl.searchParams);
		} catch (error: unknown) {
			logger.error(error);
			socket.end('HTTP/1.1 400 Bad Request');
			return;
		}

		socket.on('error', e => {
			logger.error(`[${connectionOptions.reconnectionToken}] Socket failed for "${req.url}".`, e);
		});

		const { responseHeaders, permessageDeflate } = createReponseHeaders(req.headers);
		socket.write(responseHeaders);

		codeServer.handleWebSocket(socket, connectionOptions, permessageDeflate);
	};

	httpServer.on('upgrade', upgrade);

	return new Promise((resolve, reject) => {
		httpServer.listen(parseInt(serverUrl.port, 10), serverUrl.hostname, () => {
			logger.info('Code Server active listening at:', serverUrl.toString());
		});
	});
}
