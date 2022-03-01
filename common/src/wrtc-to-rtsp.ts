import { RTCAVSignalingSetup, RTCSignalingChannel, FFMpegInput, MediaStreamOptions } from "@scrypted/sdk/types";
import { listenZeroSingleClient } from "./listen-cluster";
import { RTCPeerConnection, RTCRtpCodecParameters } from "@koush/werift";
import dgram from 'dgram';
import { RtspServer } from "./rtsp-server";
import { Socket } from "net";
import { RTCEndSession, ScryptedDeviceBase } from "@scrypted/sdk";

// this is an sdp corresponding to what is requested from webrtc.
// h264 baseline and opus are required codecs that all webrtc implementations must provide.
function createSdpInput(audioPort: number, videoPort: number, sdp: string) {
    let outputSdp = sdp
        .replace(/m=audio \d+/, `m=audio ${audioPort}`)
        .replace(/m=video \d+/, `m=video ${videoPort}`);

    const lines = outputSdp.split('\n').map(line => line.trim());
    const vindex = lines.findIndex(line => line.startsWith('m=video'));
    lines.splice(vindex + 1, 0, 'a=control:trackID=video');
    const aindex = lines.findIndex(line => line.startsWith('m=audio'));
    lines.splice(aindex + 1, 0, 'a=control:trackID=audio');
    outputSdp = lines.join('\r\n')
    return outputSdp;
}

const useUdp = true;

export function getRTCMediaStreamOptions(id: string, name: string): MediaStreamOptions {
    return {
        // set by consumer
        id,
        name,
        // not compatible with scrypted parser currently when it is udp
        tool: useUdp ? undefined : 'scrypted',
        container: 'rtsp',
        video: {
            codec: 'h264',
        },
        audio: {
            codec: 'opus',
        },
    };
}

export async function createRTCPeerConnectionSource(channel: ScryptedDeviceBase & RTCSignalingChannel, id: string): Promise<FFMpegInput> {
    const { console, name } = channel;
    const videoPort = Math.round(Math.random() * 10000 + 30000);
    const audioPort = Math.round(Math.random() * 10000 + 30000);

    const { clientPromise, port } = await listenZeroSingleClient();

    let pictureLossInterval: NodeJS.Timeout;
    let pc: RTCPeerConnection;
    let socket: Socket;
    // rtsp server must operate in udp forwarding mode to accomodate packet reordering.
    let udp = dgram.createSocket('udp4');
    let endSession: RTCEndSession;

    const cleanup = () => {
        console.log('webrtc/rtsp cleaning up');
        pc?.close();
        socket?.destroy();
        clearInterval(pictureLossInterval);
        try {
            udp.close();
        }
        catch (e) {
        }
        endSession?.().catch(() => {});
    };

    clientPromise.then(async (client) => {
        socket = client;
        const rtspServer = new RtspServer(socket, undefined, udp);
        // rtspServer.console = console;
        rtspServer.audioChannel = 0;
        rtspServer.videoChannel = 2;

        const pc = new RTCPeerConnection({
            codecs: {
                audio: [
                    new RTCRtpCodecParameters({
                        mimeType: "audio/opus",
                        clockRate: 48000,
                        channels: 2,
                    })
                ],
                video: [
                    new RTCRtpCodecParameters({
                        mimeType: "video/H264",
                        clockRate: 90000,
                        rtcpFeedback: [
                            { type: "transport-cc" },
                            { type: "ccm", parameter: "fir" },
                            { type: "nack" },
                            { type: "nack", parameter: "pli" },
                            { type: "goog-remb" },
                        ],
                        parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
                    })
                ],
            }
        });

        socket.on('close', cleanup);
        socket.on('error', cleanup);
        pc.iceConnectionStateChange.subscribe(() => {
            console.log('iceConnectionStateChange', pc.connectionState, pc.iceConnectionState);
            if (pc.iceConnectionState === 'disconnected'
                || pc.iceConnectionState === 'failed'
                || pc.iceConnectionState === 'closed') {
                cleanup();
            }
        });
        pc.connectionStateChange.subscribe(() => {
            console.log('connectionStateChange', pc.connectionState, pc.iceConnectionState);
            if (pc.connectionState === 'closed'
                || pc.connectionState === 'disconnected'
                || pc.connectionState === 'failed') {
                cleanup();
            }
        });

        const doSetup = async (setup: RTCAVSignalingSetup) => {
            let gotAudio = false;
            let gotVideo = false;

            const audioTransceiver = pc.addTransceiver("audio", setup.audio as any);
            audioTransceiver.onTrack.subscribe((track) => {
                // audioTransceiver.sender.replaceTrack(track);
                track.onReceiveRtp.subscribe((rtp) => {
                    if (!gotAudio) {
                        gotAudio = true;
                        console.log('received first audio packet');
                    }
                    rtspServer.sendAudio(rtp.serialize(), false);
                });
                track.onReceiveRtcp.subscribe(rtcp => rtspServer.sendAudio(rtcp.serialize(), true));
            });

            const videoTransceiver = pc.addTransceiver("video", setup.video as any);
            videoTransceiver.onTrack.subscribe((track) => {
                // videoTransceiver.sender.replaceTrack(track);
                track.onReceiveRtp.subscribe((rtp) => {
                    if (!gotVideo) {
                        gotVideo = true;
                        console.log('received first video packet');
                    }
                    rtspServer.sendVideo(rtp.serialize(), false);
                });
                track.onReceiveRtcp.subscribe(rtcp => rtspServer.sendVideo(rtcp.serialize(), true))
                // track.onReceiveRtp.once(() => {
                //     pictureLossInterval = setInterval(() => videoTransceiver.receiver.sendRtcpPLI(track.ssrc!), 4000);
                // });
            });
        }

        endSession = await channel.startRTCSignalingSession({
            createLocalDescription: async (type, setup, sendIceCandidate) => {
                if (type === 'offer')
                    doSetup(setup);
                if (setup.datachannel)
                    pc.createDataChannel(setup.datachannel.label, setup.datachannel.dict);

                const gatheringPromise = pc.iceGatheringState === 'complete' ? Promise.resolve(undefined) : new Promise(resolve => pc.iceGatheringStateChange.subscribe(state => {
                    if (state === 'complete')
                        resolve(undefined);
                }));
                pc.onicecandidate = ev => {
                    sendIceCandidate?.(ev.candidate as any);
                };

                if (type === 'answer') {
                    let answer = await pc.createAnswer();
                    const set = pc.setLocalDescription(answer);
                    if (sendIceCandidate)
                        return answer as any;
                    await set;
                    await gatheringPromise;
                    answer = pc.localDescription || answer;
                    return answer as any;
                }
                else {
                    let offer = await pc.createOffer();
                    const set = pc.setLocalDescription(offer);
                    if (sendIceCandidate)
                        return offer as any;
                    await set;
                    await gatheringPromise;
                    offer = await pc.createOffer();
                    return offer as any;
                }
            },
            setRemoteDescription: async (description: RTCSessionDescriptionInit, setup: RTCAVSignalingSetup) => {
                if (description.type === 'offer')
                    doSetup(setup);
                rtspServer.sdp = createSdpInput(audioPort, videoPort, description.sdp);

                if (useUdp) {
                    rtspServer.udpPorts = {
                        video: videoPort,
                        audio: audioPort,
                    };
                    rtspServer.client.write(rtspServer.sdp + '\r\n');
                    rtspServer.client.end();
                    rtspServer.client.on('data', () => {});
                    // rtspServer.client.destroy();
                    console.log('sdp sent');
                }
                else {
                    await rtspServer.handleSetup();
                }
                await pc.setRemoteDescription(description as any);
            },
            addIceCandidate: async (candidate: RTCIceCandidateInit) => {
                await pc.addIceCandidate(candidate as RTCIceCandidate);
            },
        });
    })
        .catch(e => cleanup);


    const mediaStreamOptions = getRTCMediaStreamOptions(id, name);
    if (useUdp) {
        const url = `tcp://127.0.0.1:${port}`;

        mediaStreamOptions.container = 'sdp';
        return {
            url,
            mediaStreamOptions,
            inputArguments: [
                '-protocol_whitelist', 'pipe,udp,rtp,file,crypto,tcp',
                '-acodec', 'libopus',
                "-f", "sdp",
                // hint to ffmpeg for how long to wait for out of order packets.
                // is only used by udp, i think? unsure. but it causes severe jitter
                // when there are late or missing packets.
                // the jitter buffer should be on the actual rendering side.
                // "-max_delay", "0",
                '-i', url,
            ]
        };
    }
    else {
        const url = `rtsp://127.0.0.1:${port}`;
        return {
            url,
            mediaStreamOptions,
            inputArguments: [
                "-rtsp_transport", "tcp",
                // hint to ffmpeg for how long to wait for out of order packets.
                // is only used by udp, i think? unsure. but it causes severe jitter
                // when there are late or missing packets.
                // the jitter buffer should be on the actual rendering side.
                // "-max_delay", "0",
                '-i', url,
            ]
        };
    }
}
