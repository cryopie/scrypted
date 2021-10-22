import sdk, { MediaObject, ScryptedInterface, Setting, ScryptedDeviceType, PictureOptions, VideoCamera } from "@scrypted/sdk";
import { EventEmitter, Stream } from "stream";
import { RtspSmartCamera, RtspProvider, Destroyable, RtspMediaStreamOptions } from "../../rtsp/src/rtsp";
import { connectCameraAPI, OnvifCameraAPI, OnvifEvent } from "./onvif-api";

const { mediaManager, systemManager } = sdk;

function computeInterval(fps: number, govLength: number) {
    if (!fps || !govLength)
        return;
    return govLength / fps * 1000;
}

function computeBitrate(bitrate: number) {
    if (!bitrate)
        return;
    return bitrate * 1000;
}

function convertAudioCodec(codec: string) {
    if (codec === 'MP4A-LATM')
        return 'aac';
    return codec;
}

class OnvifCamera extends RtspSmartCamera {
    eventStream: Stream;
    client: OnvifCameraAPI;

    async getPictureOptions(): Promise<PictureOptions[]> {
        try {
            const vso = await this.getVideoStreamOptions();
            const ret = vso.map(({ id, name, video }) => ({
                id,
                name,
                // onvif doesn't actually specify the snapshot dimensions for a profile.
                // it may just send whatever.
                picture: {
                    width: video?.width,
                    height: video?.height,
                }
            }));
            return ret;
        }
        catch (e) {
        }
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const client = await this.getClient();
        // if no id is provided, choose the first available/enabled profile
        if (!options?.id) {
            try {
                const vsos = await this.getVideoStreamOptions();
                const vso = vsos.find(vso => this.isChannelEnabled(vso.id));
                const snapshot = await client.jpegSnapshot(vso?.id);
                // it is possible that onvif does not support snapshots, in which case return the video stream
                if (!snapshot) {
                    // grab the real device rather than the using this.getVideoStream
                    // so we can take advantage of the rebroadcast plugin if available.
                    const realDevice = systemManager.getDeviceById<VideoCamera>(this.id);
                    return realDevice.getVideoStream({
                        id: options.id,
                    })
                }
                return mediaManager.createMediaObject(snapshot, 'image/jpeg');
            }
            catch (e) {
            }
        }

        return mediaManager.createMediaObject(client.jpegSnapshot(options?.id), 'image/jpeg');
    }

    async getConstructedVideoStreamOptions(): Promise<RtspMediaStreamOptions[]> {
        try {
            const client = await this.getClient();
            const profiles: any[] = await client.getProfiles();
            const ret: RtspMediaStreamOptions[] = [];
            for (const { $, name, videoEncoderConfiguration, audioEncoderConfiguration } of profiles) {
                ret.push({
                    id: $.token,
                    name: name,
                    url: await client.getStreamUrl($.token),
                    video: {
                        fps: videoEncoderConfiguration?.rateControl?.frameRateLimit,
                        bitrate: computeBitrate(videoEncoderConfiguration?.rateControl?.bitrateLimit),
                        width: videoEncoderConfiguration?.resolution?.width,
                        height: videoEncoderConfiguration?.resolution?.height,
                        codec: videoEncoderConfiguration?.encoding?.toLowerCase(),
                        idrIntervalMillis: computeInterval(videoEncoderConfiguration?.rateControl?.frameRateLimit,
                            videoEncoderConfiguration?.$.GovLength),
                    },
                    audio: this.isAudioDisabled() ? null : {
                        bitrate: computeBitrate(audioEncoderConfiguration?.bitrate),
                        codec: convertAudioCodec(audioEncoderConfiguration?.encoding),
                    }
                })
            }
            return ret;
        }
        catch (e) {
        }
    }


    listenEvents(): EventEmitter & Destroyable {
        let motionTimeout: NodeJS.Timeout;

        (async () => {
            const client = await this.createClient();
            const events = client.listenEvents();
            events.on('event', event => {
                if (event === OnvifEvent.MotionBuggy) {
                    this.motionDetected = true;
                    clearTimeout(motionTimeout);
                    motionTimeout = setTimeout(() => this.motionDetected = false, 30000);
                    return;
                }

                if (event === OnvifEvent.MotionStart)
                    this.motionDetected = true;
                else if (event === OnvifEvent.MotionStop)
                    this.motionDetected = false;
                else if (event === OnvifEvent.AudioStart)
                    this.audioDetected = true;
                else if (event === OnvifEvent.AudioStop)
                    this.audioDetected = false;
                else if (event === OnvifEvent.BinaryStart)
                    this.binaryState = true;
                else if (event === OnvifEvent.BinaryStop)
                    this.binaryState = false;
            })
        })();
        const ret: any = new EventEmitter();
        ret.destroy = () => {
        };
        return ret;
    }

    createClient() {
        return connectCameraAPI(this.getIPAddress(), this.getUsername(), this.getPassword(), this.console, this.storage.getItem('onvifDoorbellEvent'), !!this.storage.getItem('debug'));
    }

    async getClient() {
        if (!this.client)
            this.client = await this.createClient();
        return this.client;
    }

    showRtspUrlOverride() {
        return false;
    }

    showRtspPortOverride() {
        return false;
    }

    showHttpPortOverride() {
        return false;
    }

    showSnapshotUrlOverride() {
        return false;
    }

    async getOtherSettings(): Promise<Setting[]> {
        return [
            {
                title: 'Onvif Doorbell',
                type: 'boolean',
                description: 'Enable if this device is a doorbell',
                key: 'onvifDoorbell',
                value: (!!this.providedInterfaces?.includes(ScryptedInterface.BinarySensor)).toString(),
            },
            {
                title: 'Onvif Doorbell Event Name',
                type: 'string',
                description: 'Onvif event name to trigger the doorbell',
                key: "onvifDoorbellEvent",
                value: this.storage.getItem('onvifDoorbellEvent'),
                placeholder: 'EventName'
            }
        ]
    }

    async putSetting(key: string, value: string) {
        this.client = undefined;
        if (key !== 'onvifDoorbell')
            return super.putSetting(key, value);

        this.storage.setItem(key, value);
        if (value === 'true')
            this.provider.updateDevice(this.nativeId, this.name, [...this.provider.getInterfaces(), ScryptedInterface.BinarySensor], ScryptedDeviceType.Doorbell)
        else
            this.provider.updateDevice(this.nativeId, this.name, this.provider.getInterfaces())
    }
}

class OnvifProvider extends RtspProvider {
    getAdditionalInterfaces() {
        return [
            ScryptedInterface.Camera,
            ScryptedInterface.AudioSensor,
            ScryptedInterface.MotionSensor,
        ];
    }

    getDevice(nativeId: string): object {
        return new OnvifCamera(nativeId, this);
    }
}

export default new OnvifProvider();
