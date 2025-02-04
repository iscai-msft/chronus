try {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  await import("source-map-support/register.js");
} catch {
  // package only present in dev.
}
import { getOctokit, context as githubActionContext } from "@actions/github";
import type { ChangeStatus, ChronusWorkspace, PackageStatus } from "@chronus/chronus";
import { NodeChronusHost, getWorkspaceStatus, loadChronusWorkspace } from "@chronus/chronus";
import { printChangeDescription, resolveChangeRelativePath, type ChangeDescription } from "@chronus/chronus/change";
import { collapsibleSection } from "./markdown.js";

interface Context {
  repoName?: string;
  repoOwner?: string;
  prNumber?: number;
  headRef?: string;
  prTitle?: string;
}

function getGithubContext(): Context | undefined {
  // eslint-disable-next-line no-console
  console.log("Github context", githubActionContext);

  if (
    githubActionContext === undefined ||
    (githubActionContext.eventName !== "pull_request" && githubActionContext.eventName !== "pull_request_target")
  ) {
    return undefined;
  }
  if (githubActionContext.payload.pull_request === undefined) {
    throw new Error("Cannot run outside of a pull request");
  }
  return {
    repoName: githubActionContext.repo.repo,
    repoOwner: githubActionContext.repo.owner,
    prNumber: githubActionContext.issue.number,
    headRef: githubActionContext.payload.pull_request.head.ref,
    prTitle: githubActionContext.payload.pull_request.title,
  };
}

function getAzureDevopsContext(): Context | undefined {
  const repo = process.env["BUILD_REPOSITORY_NAME"];
  if (repo === undefined) {
    return undefined;
  }
  const [repoOwner, repoName] = repo.split("/", 2);
  const values = {
    prNumber: process.env["SYSTEM_PULLREQUEST_PULLREQUESTNUMBER"],
    repoName,
    repoOwner,
    headRef: process.env["SYSTEM_PULLREQUEST_SOURCEBRANCH"],
  };

  return values.prNumber && values.repoName && values.repoOwner && values.headRef ? (values as any) : undefined;
}

function getGenericContext(): Context | undefined {
  const values = {
    prNumber: process.env["GH_PR_NUMBER"] ? Number(process.env["GH_PR_NUMBER"]) : undefined,
    repoOwner: process.env["GH_REPO_OWNER"],
    repoName: process.env["GH_REPO_NAME"],
    headRef: process.env["GH_PR_HEAD_REF"],
    prTitle: process.env["GH_PR_TITLE"],
  };

  return values;
}

const magicString = "<!--chronus-github-change-commenter-->";
async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  const context = getGithubContext() ?? getAzureDevopsContext() ?? getGenericContext();
  // eslint-disable-next-line no-console
  console.log("Resolved context", context);
  if (!context?.prNumber) {
    throw new Error("PR number not found. Set $GH_PR_NUMBER");
  }

  if (context?.repoOwner === undefined) {
    throw new Error("Repo owner not found. Set $GH_REPO_OWNER");
  }
  if (!context?.repoName) {
    throw new Error("Repo name not found. Set $GH_REPO_NAME");
  }
  if (!context?.headRef) {
    throw new Error("Head ref not found. Set $GH_PR_HEAD_REF");
  }

  const github = getOctokit(token);

  const pr = await github.rest.pulls.get({
    pull_number: context.prNumber,
    owner: context.repoOwner,
    repo: context.repoName,
  });
  const host = NodeChronusHost;
  const workspace = await loadChronusWorkspace(host, process.cwd());
  const status = await getWorkspaceStatus(host, workspace);

  if (!context.prTitle) {
    context.prTitle = pr.data.title;
  }

  const content = resolveComment(workspace, status, pr.data, context as any);

  const comments = await github.rest.issues.listComments({
    issue_number: context.prNumber,
    owner: context.repoOwner,
    repo: context.repoName,
  });
  const existingComment = comments.data.find((x) => x.body?.includes(magicString));

  if (existingComment) {
    await github.rest.issues.updateComment({
      comment_id: existingComment.id,
      owner: context.repoOwner,
      repo: context.repoName,
      body: content,
    });
  } else {
    await github.rest.issues.createComment({
      issue_number: context.prNumber,
      owner: context.repoOwner,
      repo: context.repoName,
      body: content,
    });
  }
}

function resolveComment(
  workspace: ChronusWorkspace,
  status: ChangeStatus,
  pr: any,
  context: Required<Context>,
): string {
  const undocummentedPackages = [...status.packages.values()].filter((x) => x.changed && !x.documented);
  const documentedPackages = [...status.packages.values()].filter((x) => x.changed && x.documented);

  const content = [magicString];

  if (undocummentedPackages.length > 0) {
    content.push(
      `:x: There is undocummented changes. Run \`chronus add\` to add a changeset or [click here](${newChangeDescriptionUrl(workspace, undocummentedPackages, pr, context)}).`,
    );
    content.push("");
    content.push(`**The following packages have changes but are not documented.**`);
    for (const pkg of undocummentedPackages) {
      content.push(` - :x:\`${pkg.package.name}\``);
    }

    if (documentedPackages.length > 0) {
      content.push("");
      content.push(`The following packages have already been documented:`);

      for (const pkg of documentedPackages) {
        content.push(` - :white_check_mark: \`${pkg.package.name}\``);
      }
    }
    content.push("");
    content.push(showChanges(status, pr, context));
  } else if (documentedPackages.length > 0) {
    content.push(`All changed packages have been documented.`);
    for (const pkg of documentedPackages) {
      content.push(` - :white_check_mark: \`${pkg.package.name}\``);
    }
    content.push("");
    content.push(showChanges(status, pr, context));
  } else {
    content.push(`No changes needing a change description found.`);
  }
  return content.join("\n");
}

function showChanges(status: ChangeStatus, pr: any, context: Context) {
  const summaries = status.all.changeDescriptions
    .flatMap((change) => {
      return change.packages.flatMap((pkgName) => {
        const editLink = `[✏️](${editChangeDescriptionUrl(change, pr, context)})`;
        return [
          `### \`${pkgName}\` - _${change.changeKind.name}_ ${editLink}`,
          change.content.split("\n").map((x) => `> ${x}`),
        ];
      });
    })
    .join("\n");
  return collapsibleSection("Show changes", summaries);
}

function newChangeDescriptionUrl(
  workspace: ChronusWorkspace,
  undocummentedPackages: PackageStatus[],
  pr: any,
  context: Required<Context>,
): string {
  const repoUrl = pr.head.repo.html_url;

  const date = new Date();
  const id = [
    context.headRef.replace(/\//g, "-"),
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].join("-");
  const filename = resolveChangeRelativePath(id);
  const content = printChangeDescription(
    {
      changeKind: getDefaultChangeKind(workspace),
      packages: undocummentedPackages.map((x) => x.package.name),
      content: context.prTitle,
    },
    { frontMatterComment: `Change versionKind to one of: ${Object.keys(workspace.config.changeKinds).join(", ")}` },
  );
  return `${repoUrl}/new/${context.headRef}?filename=${filename}&value=${encodeURIComponent(content)}`;
}

function editChangeDescriptionUrl(change: ChangeDescription, pr: any, context: Context) {
  const repoUrl = pr.head.repo.html_url;
  const prRef = `/${context.repoOwner}/${context.repoName}/pull/${context.prNumber}`;

  return `${repoUrl}/edit/${context.headRef}/.chronus/changes/${change.id}.md?pr=${prRef}`;
}

function getDefaultChangeKind(workspace: ChronusWorkspace): any {
  const changeKinds = Object.values(workspace.config.changeKinds);
  const patch = changeKinds.find((x) => x.versionType === "patch");
  if (patch) return patch;
  const none = changeKinds.find((x) => x.versionType === "none");
  if (none) return none;
  return changeKinds[0];
}

await main();
