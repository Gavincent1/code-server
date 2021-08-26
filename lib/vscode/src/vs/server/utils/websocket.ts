import { createHash } from 'crypto';
import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Socket } from 'net';

export type UpgradeHandler = (request: IncomingMessage, socket: Socket, upgradeHead: Buffer) => void;

/** Magic number defined by Websocket spec. */
const WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function createReponseHeaders(incomingHeaders: IncomingHttpHeaders) {
	const acceptKey = incomingHeaders['sec-websocket-key'];
	// WebSocket standard hash suffix.
	const hash = createHash('sha1')
		.update(acceptKey + WEBSOCKET_MAGIC)
		.digest('base64');

	const responseHeaders = ['HTTP/1.1 101 Web Socket Protocol Handshake', 'Upgrade: WebSocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${hash}`];

	let permessageDeflate = false;

	if (String(incomingHeaders['sec-websocket-extensions']).indexOf('permessage-deflate') !== -1) {
		permessageDeflate = true;
		responseHeaders.push('Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=15');
	}

	return {
		responseHeaders: responseHeaders.join('\r\n') + '\r\n\r\n',
		permessageDeflate,
	};
}
