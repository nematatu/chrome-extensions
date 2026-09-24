import {
	Input,
	BufferSource,
	MP4,
	WEBM,
	Output,
	Mp4OutputFormat,
	BufferTarget,
	Conversion,
	EncodedPacketSink,
} from "./vendor/mediabunny.mjs";

export async function convertClip(
	tracks,
	range,
	{ signal, progress = () => {} } = {},
) {
	const inputs = [],
		conversions = [];
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: "in-memory" }),
		target: new BufferTarget(),
	});
	const aborted = () => {
		for (const conversion of conversions)
			void conversion.cancel().catch(() => {});
	};
	const check = () => {
		if (signal?.aborted) throw new Error("保存を中止しました。");
	};
	signal?.addEventListener("abort", aborted);
	try {
		check();
		for (const source of tracks) {
			const input = new Input({
				source: new BufferSource(source.data),
				formats: [MP4, WEBM],
			});
			inputs.push(input);
			const video = source.mime.startsWith("video/");
			const track = video
				? await input.getPrimaryVideoTrack()
				: await input.getPrimaryAudioTrack();
			if (!track)
				throw new Error("映像または音声のデータを読み取れませんでした。");
			const start = range.start - source.offset,
				end = range.end - source.offset;
			const sink = new EncodedPacketSink(track);
			const first = await sink.getKeyPacket(start + 0.001);
			if (!first || first.timestamp > start + 0.05)
				throw new Error(
					"区間の先頭データがありません。保存したい区間を再生してから押してください。",
				);
			const spans = [];
			for await (const packet of sink.packets(first, undefined, {
				metadataOnly: true,
			})) {
				check();
				if (packet.timestamp > end + 1) break;
				spans.push([packet.timestamp, packet.timestamp + packet.duration]);
				if (spans.length > 20000)
					throw new Error("処理できるデータ量を超えました。");
			}
			spans.sort((a, b) => a[0] - b[0]);
			let covered = start;
			for (const [from, to] of spans) {
				if (to <= covered) continue;
				if (from > covered + 0.12) break;
				covered = to;
			}
			if (covered < end - 0.08)
				throw new Error(
					"区間のデータがまだ揃っていません。少し待ってから再試行してください。",
				);
			const conversion = await Conversion.init({
				input,
				output,
				composable: true,
				trim: { start, end },
				copy: false,
				showWarnings: false,
				video: video
					? { codec: "avc", forceTranscode: true }
					: { discard: true },
				audio: video
					? { discard: true }
					: { codec: "aac", forceTranscode: true },
			});
			if (!conversion.isValid || conversion.discardedTracks.length) {
				throw new Error(
					"このChromeでは映像・音声をMP4に変換できません。Chromeを更新して再試行してください。",
				);
			}
			conversions.push(conversion);
			conversion.onProgress = (value) => progress(Math.round(value * 90));
		}
		check();
		await output.start();
		await Promise.all(conversions.map((conversion) => conversion.execute()));
		check();
		await output.finalize();
		const data = output.target.buffer;
		if (!data || data.byteLength < 32 || data.byteLength > 128 * 1024 * 1024)
			throw new Error("MP4のサイズが不正です。");
		const verification = new Input({
			source: new BufferSource(data),
			formats: [MP4],
		});
		inputs.push(verification);
		const video = await verification.getPrimaryVideoTrack(),
			audio = await verification.getPrimaryAudioTrack();
		if (
			!video ||
			!audio ||
			Math.abs(
				(await verification.computeDuration()) - (range.end - range.start),
			) > 0.15
		) {
			throw new Error("指定した長さのMP4を作成できませんでした。");
		}
		progress(100);
		return new Blob([data], { type: "video/mp4" });
	} finally {
		signal?.removeEventListener("abort", aborted);
		for (const conversion of conversions)
			if (conversion.state !== "done")
				await conversion.cancel().catch(() => {});
		if (output.state !== "finalized") await output.cancel().catch(() => {});
		inputs.forEach((input) => input.dispose());
	}
}
