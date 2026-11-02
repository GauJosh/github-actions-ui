"""Prints a sha256 over the files of a directory and writes it as the step output `checksum`."""
import hashlib
import os
import sys


def checksum(root: str) -> str:
    digest = hashlib.sha256()
    for dirpath, _dirs, files in sorted(os.walk(root)):
        for name in sorted(files):
            path = os.path.join(dirpath, name)
            digest.update(os.path.relpath(path, root).replace(os.sep, "/").encode())
            with open(path, "rb") as f:
                digest.update(f.read())
    return digest.hexdigest()[:16]


if __name__ == "__main__":
    value = checksum(sys.argv[1])
    print(f"Checksum of {sys.argv[1]}: {value}")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        out.write(f"checksum={value}\n")
