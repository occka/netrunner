//! DEVELOPER and GITHUB backends: scoped project files, terminals, toolchain
//! detection, Git (via the git CLI) and the GitHub REST API.

pub mod git;
pub mod github;
pub mod process;
pub mod terminal;
pub mod toolchains;
pub mod workspace;

/// Smoke tests that run the real git CLI and toolchain probes.
#[cfg(test)]
mod smoke {
    use std::collections::HashMap;

    #[test]
    fn detects_git_toolchain() {
        let found = super::toolchains::detect(&HashMap::new());
        let git = found.iter().find(|t| t.id == "git").unwrap();
        assert!(git.found, "git is installed on the build machine");
        assert!(git.version.as_deref().unwrap_or_default().contains("git version"));
    }

    #[test]
    fn git_round_trip_in_temp_repo() {
        let dir = std::env::temp_dir().join(format!("nr-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        super::git::init(&dir).unwrap();
        for (k, v) in [("user.name", "NETRUNNER test"), ("user.email", "test@netrunner.invalid")] {
            super::process::run("git", &["config", k, v], Some(&dir), std::time::Duration::from_secs(10)).unwrap();
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let s = super::git::status(&dir).unwrap();
        assert!(s.is_repo);
        assert_eq!(s.files[0].worktree, "?");
        super::git::stage(&dir, &["a.txt".into()]).unwrap();
        let hash = super::git::commit(&dir, "first").unwrap();
        assert!(!hash.is_empty());
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        let d = super::git::diff_contents(&dir, "a.txt", false).unwrap();
        assert_eq!((d.original.trim(), d.modified.trim()), ("one", "two"));
        assert_eq!(super::git::log(&dir, 5).unwrap()[0].subject, "first");
        super::git::create_branch(&dir, "feature/x").unwrap();
        assert!(super::git::branches(&dir).unwrap().contains(&"feature/x".to_string()));
        assert!(super::git::create_branch(&dir, "bad..name").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
