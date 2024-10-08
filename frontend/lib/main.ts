import "./style.css";
import iconAddComment from "iconify/add-comment-outline-rounded";
import iconComment from "iconify/comment-outline-rounded";
import iconClose from "iconify/close";

const groupBy = function <K extends string, T>(arr: T[], func: (el: T) => K) {
  return arr.reduce(
    (acc, x) => {
      (acc[func(x)] = acc[func(x)] || []).push(x);
      return acc;
    },
    {} as {
      [key: string]: T[];
    },
  );
};

type Comment = {
  id: number;
  offset: {
    start: number;
    end: number;
  };
  commenter: {
    name: string | null;
  };
  comment: string;
  created_time: string;
  pending?: boolean;
};

type GitHubMeta = {
  client_id: string;
};

type GitHubUserInfo = {
  id: number;
  name: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

let globalInitialized = false;
let apiEndpoint = "/api";

let selectedOffset: HTMLElement | null = null;

let commentsCache: Comment[] | undefined;

let commentsButton: HTMLElement;
let commentsPanel: HTMLElement;

let githubMeta: GitHubMeta;

const _fetchGitHubMeta = async () => {
  const res = await fetch(`${apiEndpoint}meta/github-app`, {
    method: "GET",
  });

  if (!res.ok) {
    throw res;
  }

  if (!githubMeta) githubMeta = (await res.json()).data;
};

const _handleOAuthToken = () => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("oauth_token");
  if (!token) return;
  document.cookie = `oauth_token=${token}; path=/; expires=${new Date(JSON.parse(atob(token.split(".")[1])).exp * 1000).toUTCString()}; secure`;
  window.history.replaceState(null, "", url.pathname);
};

const _getJWT = () => {
  // https://developer.mozilla.org/zh-CN/docs/Web/API/Document/cookie#%E7%A4%BA%E4%BE%8B_2_%E5%BE%97%E5%88%B0%E5%90%8D%E4%B8%BA_test2_%E7%9A%84_cookie
  return document.cookie.replace(
    /(?:(?:^|.*;\s*)oauth_token\s*\=\s*([^;]*).*$)|^.*$/,
    "$1",
  );
};

const _getUserInfo = () => {
  const jwt = _getJWT();
  if (!jwt) return;
  const payload = atob(jwt.split(".")[1]);

  return JSON.parse(payload) as GitHubUserInfo;
};

const _registerDialog = ({
  id,
  content,
  actions = new Map<string, (el: HTMLElement) => void>(),
  parent = document.body,
  insertPosition = "afterend",
  tag = "div",
  initialize = () => {},
}: {
  id: string;
  content: string;
  parent?: HTMLElement;
  insertPosition?: InsertPosition;
  actions?: Map<string, (el: HTMLElement) => void>;
  tag?: keyof HTMLElementTagNameMap;
  initialize?: (el: HTMLElement) => void;
}): HTMLElement => {
  let dialog = document.querySelector<HTMLElement>(`#${id}`);
  if (dialog) return dialog;

  parent.insertAdjacentHTML(
    insertPosition,
    `
    <${tag} id="${id}">
      ${content.trim()}
    </${tag}>
    `.trim(),
  );
  dialog = document.querySelector(`#${id}`)! as HTMLElement;

  initialize(dialog);

  const actionElements = dialog.querySelectorAll(`[data-action]`);
  for (const actionEl of actionElements) {
    actionEl.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent bubble so that the document click event won't be triggered
      const el = e.currentTarget as HTMLElement;
      const action = el.dataset.action ?? "";
      actions.get(action)?.(el);
    });
  }

  return dialog;
};

const _selectOffsetParagraph = ({
  el,
  focusReply = false,
}: {
  el: HTMLElement;
  focusReply?: boolean;
}) => {
  if (selectedOffset !== el) {
    selectedOffset?.classList.remove("review_selected");
    selectedOffset = el;
  }

  if (
    selectedOffset?.classList.contains("review_has_comments") === true ||
    focusReply
  ) {
    selectedOffset.classList.remove("review_focused");
    selectedOffset.classList.add("review_selected");
    _openCommentsPanel();
  }
};

const _unselectOffsetParagraph = () => {
  selectedOffset?.classList.remove("review_selected");
  selectedOffset = null;
};

const _openContextMenu = ({ el }: { el: HTMLElement }) => {
  _registerDialog({
    id: "review-context-menu",
    content: `
    <button data-action="comment">
      ${iconAddComment}
      <span>评论该段</span>
    </button>
    `,
    parent: el,
    insertPosition: "beforeend",
    actions: new Map([
      [
        "comment",
        (innerEl) => {
          innerEl.remove();
          _selectOffsetParagraph({
            el,
            focusReply: true,
          });
        },
      ],
    ]),
    initialize: (innerEl) => {
      innerEl.addEventListener("mouseenter", () => {
        el.classList.add("review_focused");
      });
      innerEl.addEventListener("mouseleave", () => {
        el.classList.remove("review_focused");
      });
    },
  });
};

const _closeContextMenu = () => {
  const contextMenu = document.querySelector("#review-context-menu")!;
  contextMenu.remove();
};

const _openCommentsPanel = async () => {
  const comments = [...(await _fetchComments())];

  const selected = selectedOffset;

  if (
    selected &&
    comments.find(
      (it) =>
        it.offset.start === parseInt(selected.dataset.originalDocumentStart!) &&
        it.offset.end === parseInt(selected.dataset.originalDocumentEnd!),
    ) === undefined
  ) {
    comments.push({
      id: -1,
      offset: {
        start: parseInt(selected.dataset.originalDocumentStart!),
        end: parseInt(selected.dataset.originalDocumentEnd!),
      },
      commenter: {
        name: "新评论",
      },
      comment: "",
      created_time: new Date().toISOString(),
      pending: true,
    });
  }

  _renderComments(comments);
  let selectedCommentsGroup = document.querySelector(
    `#review-comments-panel .comments_group[data-original-document-start="${selectedOffset?.dataset.originalDocumentStart}"][data-original-document-end="${selectedOffset?.dataset.originalDocumentEnd}"]`,
  );

  selectedCommentsGroup?.classList.add("review_selected");
  selectedCommentsGroup?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });

  commentsButton.classList.add("review_hidden");
  commentsPanel.classList.remove("review_hidden");
};

const _closeCommentsPanel = () => {
  commentsPanel.classList.add("review_hidden");
  commentsButton.classList.remove("review_hidden");
};

const _submitComment = async ({
  offsets,
  content,
}: {
  offsets: [number, number];
  content: string;
}) => {
  const commitHash = sessionStorage.getItem("commitHash");
  if (!commitHash) {
    throw new Error("找不到 Commit hash，请联系站点管理员");
  }

  const comment = {
    offset: {
      start: offsets[0],
      end: offsets[1],
    },
    comment: content,
  };

  const res = fetch(
    `${apiEndpoint}comment/${encodeURIComponent(new URL(window.location.href).pathname)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_getJWT()}`,
      },
      body: JSON.stringify({
        ...comment,
        commit_hash: commitHash,
      }),
    },
  );

  const id = commentsCache?.length ?? -1;
  if (commentsCache) {
    commentsCache.push({
      ...comment,
      commenter: {
        name: _getUserInfo()?.name ?? "未知用户",
      },
      id: commentsCache.length,
      created_time: new Date().toISOString(),
      pending: true,
    });
  }

  const resp = await res;

  if (!resp.ok) {
    if (commentsCache) {
      commentsCache = commentsCache.filter((it) => it.id !== id);
    }
    throw resp;
  }

  if (commentsCache) {
    commentsCache = commentsCache.map((it) =>
      it.id === id ? { ...it, pending: false } : it,
    );
  }

  _updateAvailableComments();
};

const _fetchComments = async () => {
  if (commentsCache) {
    return commentsCache;
  }

  const res = await fetch(
    `${apiEndpoint}comment/${encodeURIComponent(new URL(window.location.href).pathname)}`,
  );
  if (!res.ok) {
    throw res;
  }

  const comments = (await res.json()).data as Comment[];
  commentsCache = comments;

  return comments;
};

const _renderComments = (comments: Comment[]) => {
  const commentsEl = commentsPanel.querySelector(
    ".panel_main",
  )! as HTMLDivElement;

  const fragment = document.createDocumentFragment();

  const group = groupBy(
    comments,
    (it) => `${it.offset.start}-${it.offset.end}`,
  );
  for (const key of Object.keys(group).sort(
    (a, b) => parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]),
  )) {
    const container = document.createElement("div");
    container.classList.add("comments_group");

    const offsets = key.split("-");
    container.dataset.originalDocumentStart = offsets[0];
    container.dataset.originalDocumentEnd = offsets[1];

    const paragraph = document.querySelector<HTMLDivElement>(
      `.review_enabled[data-original-document-start="${container.dataset.originalDocumentStart}"][data-original-document-end="${container.dataset.originalDocumentEnd}"]`,
    );
    const content = paragraph?.textContent ?? "";

    container.innerHTML = `
      <div class="comments_group_header">
        <span class="comments_group_text_content">${content}</span>
      </div>
      <div class="comments_group_main"></div>
      <div class="comments_group_footer">
        <div class="comment_reply_panel">
          <div class="comment_username"></div>
          <textarea required placeholder="写下你的评论..."  autocapitalize="sentences" autocomplete="on" spellcheck="true" autofocus="true" maxlength="65535"></textarea>
          <div class="comment_actions comment_actions_login">
            <button class="comment_reply_item comment_reply_item_primary" data-action="login">登录到 GitHub</button>
          </div>
          <div class="comment_actions comment_actions_reply">
            <span class="comment_reply_notification"></span>
            <button class="comment_reply_item" data-action="cancel">取消</button>
            <button class="comment_reply_item comment_reply_item_primary" data-action="submit">提交</button>
          </div>
        </div>
      </div>
    `.trim();

    container
      .querySelector(".comment_reply_panel textarea")!
      .addEventListener("input", (e) => {
        const element = e.currentTarget as HTMLTextAreaElement;
        element.style.height = "5px";
        element.style.height = element.scrollHeight + "px";
      });

    const username = container.querySelector(
      ".comment_username",
    ) as HTMLDivElement;

    const commentActionsLogin = container.querySelector(
      ".comment_actions_login",
    ) as HTMLDivElement;

    const userInfo = _getUserInfo();
    if (!userInfo) {
      username.textContent = "登录到 GitHub 以发表评论";
    } else {
      username.textContent = `作为 ${userInfo.name} 发表评论`;
      commentActionsLogin.style.display = "none";
    }

    for (const actions of container.querySelectorAll(".comment_actions")) {
      actions.addEventListener("click", (e) => {
        if (!(e.target instanceof HTMLButtonElement)) return;
        const target = e.target as HTMLButtonElement;

        const textarea = container.querySelector(
          ".comment_reply_panel textarea",
        ) as HTMLTextAreaElement;

        const notification = container.querySelector(
          ".comment_reply_notification",
        ) as HTMLSpanElement;

        const submitButton = container.querySelector(
          ".comment_reply_item[data-action='submit']",
        ) as HTMLButtonElement;

        switch (target?.dataset.action) {
          case "login":
            if (!githubMeta) {
              console.log("githubMeta not ready");
              return;
            }
            window.location.href = `https://github.com/login/oauth/authorize?client_id=${githubMeta.client_id}&state=${encodeURIComponent(JSON.stringify({ redirect: window.location.href }))}`;
            break;
          case "cancel":
            textarea.disabled = false;
            textarea.value = "";
            notification.textContent = "";
            submitButton.disabled = false;
            break;
          case "submit":
            textarea.disabled = true;
            submitButton.disabled = true;

            if (!textarea.checkValidity()) {
              notification.textContent = "请填写评论内容";
              return;
            }

            notification.textContent = "";

            _submitComment({
              offsets: [
                parseInt(selectedOffset!.dataset.originalDocumentStart!),
                parseInt(selectedOffset!.dataset.originalDocumentEnd!),
              ],
              content: textarea.value,
            })
              .then(() => {
                textarea.value = "";
                notification.textContent = "";
              })

              .catch(async (e) => {
                console.error(e);

                if (e instanceof Error) {
                  notification.textContent = e.message;
                } else if (e instanceof Response) {
                  if (
                    e.headers
                      .get("content-type")
                      ?.includes("application/json") === true
                  ) {
                    const json = (await e.json()) as {
                      status: number;
                      error: string;
                    };
                    notification.textContent = json.error;
                  } else {
                    notification.textContent = `未知接口错误：${e.status}(${e.statusText})`;
                  }
                } else {
                  notification.textContent = "提交失败，请稍后再试";
                }
              })
              .finally(() => {
                _openCommentsPanel().then(() => {
                  const newNotification = commentsPanel.querySelector(
                    ".review_selected .comment_reply_notification",
                  );
                  const newTextArea = commentsPanel.querySelector(
                    ".review_selected .comment_reply_panel textarea",
                  ) as HTMLTextAreaElement;
                  if (newNotification) {
                    newNotification.textContent = notification.textContent;
                  }
                  if (newTextArea) {
                    newTextArea.value = textarea.value;
                  }
                });
              });

            _openCommentsPanel();
            break;
        }
      });
    }

    container.addEventListener("mouseenter", () => {
      paragraph?.classList.add("review_focused");
    });
    container.addEventListener("mouseleave", () => {
      paragraph?.classList.remove("review_focused");
    });
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedOffset?.classList.remove("review_selected");
      paragraph?.classList.remove("review_focused");
      paragraph?.classList.add("review_selected");
      document
        .querySelector(".comments_group.review_selected")
        ?.classList.remove("review_selected");
      container.classList.add("review_selected");
      selectedOffset = paragraph;
      selectedOffset?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });

    const commentsGroup = group[key].sort(
      (a, b) =>
        new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
    );
    const main = container.querySelector(".comments_group_main")!;

    for (const comment of commentsGroup) {
      const commentEl = document.createElement("div");
      commentEl.classList.add("comment");
      if (comment.pending) {
        commentEl.classList.add("comment_pending");
      }
      commentEl.innerHTML = `
        <div class="comment_header">
          <span class="comment_commenter"></span>
          <span class="comment_time">${dateTimeFormatter.format(new Date(comment.created_time))}</span>
        </div>
        <div class="comment_main"></div>
      `.trim();
      commentEl.querySelector(".comment_commenter")!.textContent =
        comment.commenter.name;
      commentEl.querySelector(".comment_main")!.textContent = comment.comment;
      main.appendChild(commentEl);
    }

    fragment.appendChild(container);
  }

  while (commentsEl.firstChild) {
    commentsEl.removeChild(commentsEl.firstChild);
  }
  commentsEl.appendChild(fragment);
};

const _updateAvailableComments = async () => {
  const offsets = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".review_enabled[data-original-document-start][data-original-document-end]",
    ),
  );

  await _fetchComments();

  for (let offset of offsets) {
    offset.classList.remove("review_has_comments");
    if (
      commentsCache!.find(
        (it) =>
          it.offset.start ===
            parseInt(offset!.dataset.originalDocumentStart!) &&
          it.offset.end === parseInt(offset!.dataset.originalDocumentEnd!),
      )
    ) {
      offset.classList.add("review_has_comments");
    }
  }
};

export const __VERSION__: string = __LIB_VERSION__;

export function setupReview(
  el: Element,
  { apiEndpoint: endpoint = "/api" }: { apiEndpoint?: string } = {},
) {
  apiEndpoint = endpoint.endsWith("/") ? endpoint : endpoint + "/";

  _handleOAuthToken();

  const offsets = Array.from(
    el.querySelectorAll<HTMLElement>(
      "[data-original-document-start][data-original-document-end]",
    ),
  );

  if (!offsets) {
    console.warn(
      "oiwiki-feedback-sys-frontend not found any offsets to inject, quitting...",
    );
    return;
  }

  for (let offset of offsets) {
    offset.classList.add("review_enabled");
    offset.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent bubble so that the document click event won't be triggered
      _selectOffsetParagraph({
        el: e.currentTarget as HTMLElement,
      });
    });
    offset.addEventListener("mouseenter", (e) => {
      _openContextMenu({
        el: e.currentTarget as HTMLElement,
      });
    });
    offset.addEventListener("mouseleave", () => {
      _closeContextMenu();
    });
  }

  // clear cache
  commentsCache = undefined;

  _updateAvailableComments();
  _fetchGitHubMeta();

  if (globalInitialized) {
    _closeCommentsPanel();
    console.log("oiwiki-feedback-sys-frontend has been successfully reset.");
    return;
  }

  document.addEventListener("click", () => {
    _unselectOffsetParagraph();
  });

  commentsButton = _registerDialog({
    id: "review-comments-button",
    content: `
    <button data-action="open">
      ${iconComment}
    </button>
    `,
    actions: new Map([["open", () => _openCommentsPanel()]]),
  });

  commentsPanel = _registerDialog({
    id: "review-comments-panel",
    content: `
    <div class="panel_header">
      <span>本页评论</span>
      <button data-action="close">
        ${iconClose}
      </button>
    </div>
    <div class="panel_main"></div>
    `,
    insertPosition: "beforeend",
    actions: new Map([["close", () => _closeCommentsPanel()]]),
  });

  // initialize comments panel position
  _closeCommentsPanel();

  console.log(
    `oiwiki-feedback-sys-frontend version ${__VERSION__} has been successfully installed.`,
  );

  globalInitialized = true;
}
