'use strict';

// These files can change what a seemingly harmless test/build command executes.
function requiresReview(filename) {
  const path = filename.replace(/\\/g, '/');
  return /(^|\/)(\.vscode|\.github|\.gitlab|\.devcontainer|\.husky|\.cargo)(\/|$)/i.test(path)
    || /(^|\/)[^/]*\.config\.[cm]?[jt]sx?$/i.test(path)
    || /(^|\/)\.[^/]*rc\.[cm]?[jt]sx?$/i.test(path)
    || /(^|\/)(?:[^/]*[._-])?(?:global[-_]?)?setup(?:tests)?(?:[._-][^/]*)?\.[cm]?[jt]sx?$/i.test(path)
    || /(^|\/)\.pre-commit-config\.ya?ml$/i.test(path)
    || /(^|\/)(conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|gradlew|mvnw|settings\.gradle(?:\.kts)?)$/i.test(path)
    || /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Makefile(?:\..*)?|GNUmakefile|CMakeLists\.txt|Justfile|Taskfile\.ya?ml|Jenkinsfile|Dockerfile(?:\..*)?|docker-compose[^/]*\.ya?ml|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|Gemfile(?:\.lock)?|Cargo\.toml|build\.rs|build\.gradle(?:\.kts)?|pom\.xml|Directory\.Build\.[^/]+)$/i.test(path)
    || /\.(sh|bash|zsh|cmd|bat|ps1|psm1|csproj|fsproj|vbproj|targets|props)$/i.test(path);
}
module.exports = { requiresReview };
