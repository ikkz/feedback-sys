import { GetComment, GetCommentRespBody, PostComment } from './types';

export async function postComment(env: Env, req: PostComment) {
	const db = env.DB;

	let page = await db.prepare('SELECT * FROM pages WHERE path = ?').bind(req.path).first();

	if (!page) {
		await db.prepare('INSERT INTO pages (path) VALUES (?)').bind(req.path).run();
		page = (await db.prepare('SELECT last_insert_rowid() AS id').first())!;
	}

	let offset = await db
		.prepare('SELECT * FROM offsets WHERE page_id = ? AND start = ? AND end = ?')
		.bind(page.id, req.offset.start, req.offset.end)
		.first();

	if (!offset) {
		await db.prepare('INSERT INTO offsets (page_id, start, end) VALUES (?, ?, ?)').bind(page.id, req.offset.start, req.offset.end).run();
		offset = (await db.prepare('SELECT last_insert_rowid() AS id').first())!;
	}

	await db
		.prepare('INSERT INTO commenters (name, user_agent, ip_address) VALUES (?, ?, ?)')
		.bind(req.commenter?.name, req.commenter?.user_agent, req.commenter?.ip_address)
		.run();
	const commiterId = (await db.prepare('SELECT last_insert_rowid() AS id').first())!.id;

	await db
		.prepare('INSERT INTO comments (offset_id, commenter_id, comment, created_time) VALUES (?, ?, ?, ?)')
		.bind(offset.id, commiterId, req.comment, new Date().toISOString())
		.run();
}

export async function getComment(env: Env, req: GetComment): Promise<GetCommentRespBody> {
	const db = env.DB;

	const comments = (
		await db
			.prepare(
				'SELECT *, comments.id AS id FROM comments JOIN commenters ON comments.commenter_id = commenters.id JOIN offsets ON comments.offset_id = offsets.id JOIN pages ON offsets.page_id = pages.id WHERE pages.path = ?',
			)
			.bind(req.path)
			.all()
	).results;

	return comments.map((comment) => {
		return {
			id: comment.id as number,
			offset: {
				start: comment.start as number,
				end: comment.end as number,
			},
			commenter: {
				name: comment.name as string,
			},
			comment: comment.comment as string,
			created_time: comment.created_time as string,
		};
	});
}

export async function setMeta(env: Env, key: string, value: string) {
	const db = env.DB;

	await db.prepare('INSERT OR REPLACE INTO metas (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function getMeta(env: Env, key: string): Promise<string | undefined> {
	const db = env.DB;

	const meta = await db.prepare('SELECT * FROM metas WHERE key = ?').bind(key).first<Record<'key' | 'value', string>>();

	return meta?.value;
}

export async function getPaths(env: Env): Promise<string[]> {
	const db = env.DB;

	return (await db.prepare('SELECT path FROM pages').all()).results.map((page) => page.path as string);
}

export async function setPath(env: Env, oldPath: string, newPath: string) {
	const db = env.DB;

	await db.prepare('UPDATE pages SET path = ? WHERE path = ?').bind(newPath, oldPath).run();
}

export async function isPathExists(env: Env, path: string): Promise<boolean>;
export async function isPathExists(env: Env, ...path: string[]): Promise<boolean[]>;
export async function isPathExists(env: Env, ...path: string[]): Promise<boolean | boolean[]> {
	if (typeof path === 'string') {
		path = [path];
	}

	const db = env.DB;

	const res = await db
		.prepare(`SELECT path FROM pages WHERE path IN (${new Array<string>(path.length).fill('?').join(',')})`)
		.bind(...path)
		.all<Record<string, string>>();

	if (path.length === 1) {
		return res.results.length > 0;
	}

	return path.map((p) => res.results.some((r) => r.path === p));
}

export async function updateCommentOffsets(
	env: Env,
	path: string,
	replacement: {
		from: {
			start: number;
			end: number;
		};
		to?: {
			start: number;
			end: number;
		};
	}[],
) {
	const db = env.DB;

	const page = await db.prepare('SELECT * FROM pages WHERE path = ?').bind(path).first();

	if (!page) {
		return;
	}

	for (const { from, to } of replacement) {
		if (!to) {
			const offset_id = (
				await db.prepare('SELECT id FROM offsets WHERE page_id = ? AND start = ? AND end = ?').bind(page.id, from.start, from.end).first()
			)?.id;
			if (!offset_id) continue;
			await db.prepare('DELETE FROM comments WHERE offset_id = ?').bind(offset_id).run();
			await db.prepare('DELETE FROM offsets WHERE id = ?').bind(offset_id).run();
		} else {
			await db
				.prepare('UPDATE offsets SET start = ?, end = ? WHERE page_id = ? AND start = ? AND end = ?')
				.bind(to.start, to.end, page.id, from.start, from.end)
				.run();
		}
	}
}
