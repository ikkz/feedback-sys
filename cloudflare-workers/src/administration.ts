import { getComment, getMeta, getPaths, isPathExists, setMeta, setPath, updateCommentOffsets } from './db';
import { ModifiedCommentBody } from './types';

type Replacement = {
	from: {
		start: number;
		end: number;
	};
	to?: {
		start: number;
		end: number;
	};
};

type Offset = {
	start: number;
	end: number;
};

const encoder = new TextEncoder();

export function validateSecret(env: Env, secret: string): boolean {
	const secretBytes = encoder.encode(env.ADMINISTRATOR_SECRET);
	const inputBytes = encoder.encode(secret);

	if (secretBytes.byteLength !== inputBytes.byteLength) {
		return false;
	}

	return crypto.subtle.timingSafeEqual(secretBytes, inputBytes);
}

export async function setCommitHash(env: Env, hash: string) {
	await setMeta(env, 'commit_hash', hash);
}

export async function compareCommitHash(env: Env, hash: string): Promise<boolean> {
	const storedHash = await getMeta(env, 'commit_hash');
	return storedHash === hash;
}

export async function renameComments(env: Env, oldPath: string, newPath: string) {
	if (oldPath == newPath) {
		throw new Error('The path you want to rename from and to are the same');
	}

	const [oldPathExists, newPathExists] = await isPathExists(env, oldPath, newPath);
	if (!oldPathExists) {
		return;
	}
	if (newPathExists) {
		throw new Error('The path you want to rename to already exists');
	}

	await setPath(env, oldPath, newPath);
}

export async function modifyComments(env: Env, path: string, diff: ModifiedCommentBody['diff']) {
	if (!(await isPathExists(env, path))) {
		throw new Error('The path you want to modify does not exist');
	}

	const replacement: Replacement[] = [];
	const offsets: Offset[] = []; // get offsets in some way
	const offsetsDelta: Offset[] = []; // 长度和offsets一样，但是里面的值是diff的delta，初始值是0
	// 理论上这玩意的类型最好改改，但是我为了demo就不改了

	// 时间复杂度：O(n * m)，n 是 offsets 的个数，m 是 diff 的个数
	// 这里如果用差分优化的话，可以优化到 O(n + m)。大概是用一个哈希表来维护，原文中的第i个位置，在经过一系列ops操作后的位置移动情况。将这个哈希表的值累加起来，可以得到每个位置最终的总偏移量。
	// 在我们有完整的测试用例的情况下，可以考虑这个优化。
	for (const { tag, i1, i2, j1, j2 } of diff) {
		for (let i = 0; i < offsets.length; i++) {
			const { start, end } = offsets[i];
			// 对于 insert，讨论 i1 和 [start, end] 的三种情况
			if (tag === 'insert') {
				const insertedLength = j2 - j1;
				if (i1 < start) {
					offsetsDelta[i].start += insertedLength;
				} else if (start <= i1 && i1 <= end) {
					offsetsDelta[i].end += insertedLength;
				} else {
					// i1 > end, 不受影响
				}
			} else {
				// 对于 replace 和 delete
				// 讨论 [i1, i2] 和 [start, end] 的六种情况
				// 边界点我没有仔细想就先不写了
				if (i2 < start) {
					const lengthDelta = j2 - j1 - (i2 - i1);
					offsetsDelta[i].start += lengthDelta;
					offsetsDelta[i].end += lengthDelta;
				} else if (start <= i2 && i2 <= end) {
					if (i1 < start) {
						// 这类有点复杂的例子我没有仔细想，是copilot给的
						offsetsDelta[i].end += j2 - j1 - (end - i2);
						offsetsDelta[i].start += j1 - i1;
					} else {
						offsetsDelta[i].end += j2 - j1 - (i2 - i1);
					}
				} else {
					// i2 > end
					if (i1 < start) {
						// 整个被替换/删除，应该移除掉。我这里没写！
					} else if (start <= i1 && i1 <= end) {
						offsetsDelta[i].end += j2 - j1 - (end - i1);
					} else {
					// i1 > end, 不受影响
					}
				}
			}
		}
	}
	// apply delta to offsets
	for (let i = 0; i < offsets.length; i++) {
		const { start, end } = offsets[i];
		const { start: startDelta, end: endDelta } = offsetsDelta[i];
		replacement.push({
			from: {
				start: start + startDelta,
				end: end + endDelta,
			},
		});
	}
	await updateCommentOffsets(env, path, replacement);
}
