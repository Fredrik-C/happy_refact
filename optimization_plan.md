# Plan to Optimize Workspace File Scanning

## Problem

Scanning workspaces with over 1000 files in `src\index.ts` is slow, impacting performance and user experience.

## Goal

Significantly improve the speed and efficiency of file scanning in large workspaces by implementing optimization techniques.

## Proposed Solutions

1.  **Optimize File Traversal:**
    *   **Strategy:** Replace the current file listing mechanism with a more performant method. This might involve using native Node.js modules like `fs` with optimized options, or considering third-party libraries known for efficient directory traversal (if applicable and beneficial).
    *   **Benefit:** Reduces the time spent simply listing files and navigating the directory structure.

2.  **Implement Caching:**
    *   **Strategy:** Store the list of scanned files and relevant metadata (e.g., file paths, modification timestamps, file sizes) in a cache.
    *   **Mechanism:** Before performing a full scan, check the cache. Only rescan directories or files that have been added, deleted, or modified since the last scan.
    *   **Benefit:** Avoids redundant scanning of unchanged parts of the workspace, drastically speeding up subsequent scans.

3.  **Implement Exclusions:**
    *   **Strategy:** Allow users to specify patterns (e.g., glob patterns, `.gitignore` style rules) for files and directories that should be excluded from the scan.
    *   **Mechanism:** Read exclusion patterns from a configuration file (e.g., `.scanignore` or integrate with existing `.gitignore`). Filter out excluded paths during the file traversal phase.
    *   **Benefit:** Reduces the total number of files that need to be processed.

4.  **Introduce Parallel Processing:**
    *   **Strategy:** Utilize Node.js worker threads or child processes to scan different parts of the file system concurrently.
    *   **Mechanism:** Divide the list of directories or files among multiple workers. Each worker scans its assigned portion, and the results are combined.
    *   **Benefit:** Leverages multi-core processors to perform scanning tasks in parallel, reducing overall scanning time.

5.  **Warmup/Pre-optimization:**
    *   **Strategy:** Perform an initial scan or partial scan in the background when the application starts or a workspace is opened.
    *   **Mechanism:** After the initial load, trigger a background process to build the initial cache of file information. This makes the first interactive scan faster as some data will already be available.
    *   **Benefit:** Improves the perceived performance for the user by having some data ready early.

## Implementation Steps
### Completed Steps
1.  **Implement Simple Caching in listFilesRecursively:** Completed - Added static cache to store directory contents.
2.  **Enhance Exclusion Handling in listFilesRecursively:** Completed - Optimized ignore logic for better subdirectory skipping.
3.  **Optimize Tree-sitter Query Usage in findReferencesInFile:** Completed - Cached queries and language settings to reduce overhead.
4.  **Incorporate Incremental Parsing in findReferencesInFile:** Completed - Added result caching based on file modification times.
### Additional Improvement
5.  **Introduce Analysis Timeout:** Add a 10-second timer to the scanning process in _findImpactedCode to stop after 10 seconds and report partial results, including the number of files analyzed. This ensures the function doesn't run indefinitely and provides clear indication of partial results.
### If 1-5 did not help enough, then resume with
5.  **Research and Select Libraries/APIs:** Identify suitable Node.js APIs or third-party libraries for optimized file traversal and potentially parallel processing.
6.  **Develop Caching Mechanism:** Design and implement the caching system, including how to store, update, and invalidate cache entries based on file system changes.
7.  **Integrate Parallel Processing:** Modify the scanning logic to distribute the workload across multiple workers.
8.  **Implement Warmup Scan:** Add a background process to perform an initial scan and populate the cache.
9.  **Testing and Profiling:** Thoroughly test the implemented optimizations with large workspaces and use profiling tools to measure the performance improvements and identify any new bottlenecks.
10. **Refine and Iterate:** Based on testing results, refine the implementation for further performance gains.

## Considerations

*   **Complexity:** Implementing caching and parallel processing adds complexity to the codebase.
*   **Maintenance:** The caching mechanism needs to be robust to handle various file system events (additions, deletions, modifications, renames).
*   **Configuration:** Provide clear documentation on how users can configure exclusions.
*   **Cross-Platform Compatibility:** Ensure that the chosen APIs and libraries work correctly across different operating systems.

This plan provides a roadmap for optimizing the file scanning performance. Implementing these strategies should significantly improve the application's responsiveness in large workspaces.